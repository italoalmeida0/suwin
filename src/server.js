import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import {
  SCHEMA_VERSION, PATH_STATUS, PATH_RUN, PATH_ACTIVATE, PATH_DEACTIVATE,
  CHAN_STDOUT, CHAN_STDERR, CHAN_STDIN, CHAN_STDERR_ALIAS,
  TYPE_STARTED, TYPE_EXIT, TYPE_ERROR, TYPE_INTERRUPT, TYPE_TERMINATE, TYPE_STDIN_EOF, TYPE_STDIN_ACK, TYPE_RESIZE,
  CODE_INACTIVE, CODE_BUSY, CODE_BAD_REQUEST, CODE_SPAWN_FAILED,
  REASON_DEACTIVATED, REASON_SERVICE_EXIT, MAX_ACTIVATION_MS,
  parseDuration, validateStartRequest
} from './protocol.js';
import { Session } from './runner.js';
import * as state from './state.js';
import { TrayIcon } from './tray.js';
import { enableWindowsInterrupts } from './windows.js';
import { createAuditLog } from './log.js';
import { assertNotMaintaining } from './maintenance.js';
import { VERSION } from './version.js';

export const MAX_SESSIONS = 64;
export const DEFAULT_ACTIVATION_MS = 15 * 60 * 1000;
export const KEEPALIVE_INTERVAL_MS = 15 * 1000;
const OUTPUT_HIGH_WATER = 1024 * 1024;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export class SuwinServer {
  constructor(options = {}) {
    if (process.platform === 'win32') enableWindowsInterrupts();
    this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
    this.defaultActivationMs = options.defaultActivationMs ?? DEFAULT_ACTIVATION_MS;
    this.keepAliveIntervalMs = options.keepAliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
    this.startRequestTimeoutMs = options.startRequestTimeoutMs ?? 15000;
    for (const value of [this.maxSessions, this.keepAliveIntervalMs, this.startRequestTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid server limits');
    }
    this.logger = options.logger || null;
    this.onStopped = options.onStopped || null;
    this.auditFailed = false;
    this.onStateChange = options.onStateChange || null;
    this.enableTray = Boolean(options.tray);
    this.active = false;
    this.expiresAt = null;
    this.activeTimer = null;
    this.generation = 0;
    this.sessions = new Map();
    this.connections = new Set();
    this.adminToken = crypto.randomBytes(32).toString('hex');
    this.stopToken = crypto.randomBytes(32).toString('hex');
    this.instanceId = crypto.randomBytes(8).toString('hex');
    this.startedAt = new Date();
    this.elevated = state.isElevated();
    this.currentUser = state.getCurrentUser();
    this.stateDir = '';
    this.port = 0;
    this.httpServer = null;
    this.wss = null;
    this.tray = null;
    this.closing = false;
    this.stopPromise = null;
  }

  isActive() {
    if (this.active && Date.now() >= this.expiresAt.getTime()) this.deactivate('expired');
    return this.active && !this.closing;
  }

  getSecondsLeft() {
    return this.active && this.expiresAt ? Math.max(0, Math.ceil((this.expiresAt.getTime() - Date.now()) / 1000)) : 0;
  }

  activate(durationMs = this.defaultActivationMs) {
    if (this.closing) throw new Error('The service is shutting down');
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_ACTIVATION_MS) throw new Error('Activation duration must be between 1 ms and 24 hours');
    clearTimeout(this.activeTimer);
    this.active = true;
    this.generation++;
    this.expiresAt = new Date(Date.now() + durationMs);
    this.activeTimer = setTimeout(() => this.deactivate('expired'), durationMs);
    this.audit('activated', { durationMs, expiresAt: this.expiresAt.toISOString() });
    this.tray?.update();
    this.onStateChange?.(this.getStatus());
    return this.getStatus();
  }

  deactivate(reason = REASON_DEACTIVATED) {
    clearTimeout(this.activeTimer);
    this.activeTimer = null;
    const wasActive = this.active;
    this.active = false;
    this.generation++;
    this.expiresAt = null;
    if (wasActive) this.audit('deactivated', { reason, sessions: this.sessions.size });
    for (const session of this.sessions.values()) {
      session.terminate(reason);
      session.resumeOutput();
    }
    this.tray?.update();
    if (wasActive) this.onStateChange?.(this.getStatus());
    return this.getStatus();
  }

  getStatus() {
    const active = this.isActive();
    return {
      schema: SCHEMA_VERSION, version: VERSION, pid: process.pid, home: state.getSuwinHome(), port: this.port,
      instance: this.instanceId, started: this.startedAt.toISOString(), active,
      expiresAt: active ? this.expiresAt.toISOString() : null,
      secondsLeft: this.getSecondsLeft(), sessions: this.sessions.size,
      maxSessions: this.maxSessions, elevated: this.elevated, currentUser: this.currentUser,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000)
    };
  }

  async start(port = 0) {
    if (this.httpServer || this.closing) throw new Error('The service cannot be started twice');
    this.stateDir = state.ensureDir();
    assertNotMaintaining(this.stateDir);
    this.releaseLock = state.acquireServiceLock(this.stateDir, this.instanceId);
    this.httpServer = http.createServer((req, res) => {
      try { this.handleHttp(req, res); }
      catch { json(res, 400, { error: 'Invalid request' }); }
    });
    this.httpServer.headersTimeout = 10000;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });
    this.httpServer.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {});
      try { this.handleUpgrade(req, socket, head); }
      catch { socket.destroy(); }
    });
    try {
      assertNotMaintaining(this.stateDir);
      this.logger ||= createAuditLog(this.stateDir);
      await new Promise((resolve, reject) => {
        this.httpServer.once('error', reject);
        this.httpServer.listen(port, '127.0.0.1', resolve);
      });
      this.port = this.httpServer.address().port;
      if (this.enableTray && process.platform === 'win32') {
        this.tray = new TrayIcon(this);
        await this.tray.start();
      }
      assertNotMaintaining(this.stateDir);
      state.writeEndpoint(this.stateDir, {
        port: this.port, instance: this.instanceId, version: VERSION,
        elevated: this.elevated, started: this.startedAt.toISOString(), stopToken: this.stopToken
      });
      this.audit('service_started', { pid: process.pid, port: this.port, elevated: this.elevated, version: VERSION });
      return { port: this.port, dir: this.stateDir, elevated: this.elevated };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.headers.origin) return json(res, 403, { error: 'cross-origin requests are not allowed' });
    if (url.pathname === PATH_STATUS && req.method === 'GET') return json(res, 200, this.getStatus());
    const matches = (value, expected) => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(expected) &&
      crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
    const authorized = matches(req.headers['x-suwin-token'], this.adminToken);
    // The on-disk capability can only stop the service. It cannot activate it.
    if (url.pathname === '/v1/quit' && req.method === 'POST' && (authorized || matches(req.headers['x-suwin-stop-token'], this.stopToken))) {
      json(res, 200, { ok: true });
      void this.stop();
      return;
    }
    if ([PATH_ACTIVATE, PATH_DEACTIVATE, '/v1/quit'].includes(url.pathname) && req.method === 'POST') {
      if (!authorized) return json(res, 403, { error: 'Use the Tray Icon to authorize administrative operations.' });
      if (url.pathname === PATH_ACTIVATE) {
        try { return json(res, 200, this.activate(url.searchParams.has('duration') ? parseDuration(url.searchParams.get('duration'), 0) : this.defaultActivationMs)); }
        catch (error) { return json(res, 400, { error: error.message }); }
      }
      if (url.pathname === PATH_DEACTIVATE) return json(res, 200, this.deactivate('manual'));
      json(res, 200, { ok: true });
      void this.stop();
      return;
    }
    json(res, 404, { error: 'not found' });
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const reject = (code, reason) => socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (req.headers.origin) return reject(403, 'Forbidden');
    if (url.pathname !== PATH_RUN) return reject(404, 'Not Found');
    if (!this.isActive()) return reject(503, 'Service Unavailable');
    if (this.connections.size >= this.maxSessions) return reject(429, 'Too Many Requests');
    this.wss.handleUpgrade(req, socket, head, ws => {
      this.connections.add(ws);
      this.handleClientSession(ws, this.generation);
    });
  }

  handleClientSession(ws, generation) {
    let session = null, alive = true, pendingOutput = 0;
    const sendError = (code, message) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: TYPE_ERROR, code, message }), () => ws.close());
    };
    const startTimer = setTimeout(() => sendError(CODE_BAD_REQUEST, 'Start request timed out'), this.startRequestTimeoutMs);
    const pingTimer = setInterval(() => {
      if (!alive || ws.readyState !== WebSocket.OPEN) {
        session?.terminate('keepalive_timeout');
        session?.resumeOutput();
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, this.keepAliveIntervalMs);
    ws.on('pong', () => { alive = true; });

    const sendOutput = (channel, chunk) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const frame = Buffer.concat([Buffer.from([channel]), chunk]);
      pendingOutput += frame.length;
      if (pendingOutput >= OUTPUT_HIGH_WATER) session.pauseOutput();
      ws.send(frame, { binary: true }, error => {
        pendingOutput -= frame.length;
        if (error) { session.terminate('client_error'); session.resumeOutput(); }
        else if (pendingOutput < OUTPUT_HIGH_WATER / 2) session.resumeOutput();
      });
    };

    ws.once('message', (firstData, binary) => {
      clearTimeout(startTimer);
      let req;
      try {
        if (binary) throw new Error('First frame must be a JSON start request');
        req = validateStartRequest(JSON.parse(firstData.toString()));
      } catch (error) { sendError(CODE_BAD_REQUEST, error.message); return; }
      // Recheck after the first frame: a socket opened during a previous
      // authorization window must never launch a command after revocation.
      if (!this.isActive() || generation !== this.generation) return sendError(CODE_INACTIVE, 'The supervisor session is inactive or has changed');
      if (this.sessions.size >= this.maxSessions) return sendError(CODE_BUSY, 'Too many concurrent commands');
      try {
        this.audit('session_requested', { program: req.shell ? 'cmd.exe' : path.basename(req.argv[0]), argc: req.argv.length - 1 });
        if (this.auditFailed) throw new Error('Audit log is unavailable; the supervisor is shutting down');
        session = new Session(req, {
          onStdout: chunk => sendOutput(CHAN_STDOUT, chunk),
          onStderr: chunk => sendOutput(CHAN_STDERR, chunk),
          onExit: ({ code, reason }) => {
            clearInterval(pingTimer);
            this.sessions.delete(session.id);
            this.audit('session_exited', { session: session.id, code, reason });
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: TYPE_EXIT, code, reason }), () => ws.close(1000, 'done'));
          }
        });
        const info = session.start();
        this.sessions.set(session.id, session);
        this.audit('session_started', { session: session.id, pid: info.pid, program: req.shell ? 'cmd.exe' : path.basename(req.argv[0]), argc: req.argv.length - 1, cwd: info.cwd, mode: info.mode });
        ws.send(JSON.stringify({ type: TYPE_STARTED, sessionId: info.id, ...info, stdinAck: true }));
      } catch (error) {
        clearInterval(pingTimer);
        sendError(CODE_SPAWN_FAILED, error.message);
        return;
      }
      ws.on('message', (data, binary) => {
        if (session.finished) return;
        try {
          if (binary) {
            if (data[0] === CHAN_STDIN || data[0] === CHAN_STDERR_ALIAS) {
              session.writeStdin(data.subarray(1), () => {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: TYPE_STDIN_ACK, bytes: data.length - 1 }));
              });
            }
          } else {
            const msg = JSON.parse(data.toString());
            if (msg.type === TYPE_INTERRUPT) session.interrupt();
            else if (msg.type === TYPE_TERMINATE) session.terminate();
            else if (msg.type === TYPE_STDIN_EOF) session.endStdin();
            else if (msg.type === TYPE_RESIZE) session.resize(msg.cols, msg.rows);
          }
        } catch (error) {
          sendError(CODE_BAD_REQUEST, error.message);
          session.terminate('bad_request');
          session.resumeOutput();
        }
      });
    });

    const disconnect = () => {
      clearTimeout(startTimer);
      clearInterval(pingTimer);
      this.connections.delete(ws);
      session?.terminate('client_closed');
      session?.resumeOutput();
    };
    ws.on('close', disconnect);
    ws.on('error', disconnect);
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.closing = true;
    this.stopPromise = (async () => {
      this.deactivate(REASON_SERVICE_EXIT);
      for (const ws of this.connections) ws.terminate();
      await Promise.all([...this.sessions.values()].map(session => session.done));
      await this.tray?.destroy();
      this.tray = null;
      if (this.stateDir) state.removeEndpoint(this.stateDir, this.instanceId);
      this.releaseLock?.();
      this.releaseLock = null;
      this.wss?.close();
      if (this.httpServer?.listening) {
        await new Promise(resolve => {
          this.httpServer.close(resolve);
          this.httpServer.closeIdleConnections?.();
        });
      }
      this.audit('service_stopped', { pid: process.pid });
      this.onStopped?.();
    })();
    return this.stopPromise;
  }

  audit(event, fields = {}) {
    if (!this.logger || this.auditFailed) return;
    try { this.logger.info(event, fields); }
    catch (error) {
      this.auditFailed = true;
      console.error(`[suwinsvc] Audit log failed: ${error.message}`);
      queueMicrotask(() => this.stop().catch(stopError => console.error(stopError.message)));
    }
  }
}
