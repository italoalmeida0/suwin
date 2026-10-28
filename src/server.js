// server.js - HTTP and WebSocket daemon server for suwin
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import {
  SCHEMA_VERSION,
  PATH_STATUS,
  PATH_RUN,
  PATH_ACTIVATE,
  PATH_DEACTIVATE,
  CHAN_STDOUT,
  CHAN_STDERR,
  CHAN_STDIN,
  CHAN_STDERR_ALIAS,
  TYPE_START,
  TYPE_STARTED,
  TYPE_EXIT,
  TYPE_ERROR,
  TYPE_INTERRUPT,
  TYPE_TERMINATE,
  TYPE_STDIN_EOF,
  TYPE_RESIZE,
  CODE_INACTIVE,
  CODE_BUSY,
  CODE_BAD_REQUEST,
  CODE_SPAWN_FAILED,
  REASON_DEACTIVATED,
  REASON_SERVICE_EXIT,
  parseDuration
} from './protocol.js';
import { Session } from './runner.js';
import * as state from './state.js';
import { TrayIcon } from './tray.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MAX_SESSIONS = 64;
export const DEFAULT_ACTIVATION_MS = 15 * 60 * 1000; // 15 minutes
export const KEEPALIVE_INTERVAL_MS = 15 * 1000;      // 15 seconds

export class SuwinServer {
  constructor(options = {}) {
    this.maxSessions = options.maxSessions || MAX_SESSIONS;
    this.defaultActivationMs = options.defaultActivationMs || DEFAULT_ACTIVATION_MS;
    this.logger = options.logger || console;
    this.onStateChange = options.onStateChange || null;
    this.enableTray = Boolean(options.tray);

    this.active = false;
    this.expiresAt = null;
    this.activeTimer = null;
    this.sessions = new Map();
    this.adminToken = crypto.randomBytes(32).toString('hex');
    this.instanceId = crypto.randomBytes(8).toString('hex');
    this.startedAt = new Date();
    this.elevated = state.isElevated();
    this.currentUser = state.getCurrentUser();
    this.stateDir = '';
    this.port = 0;

    this.httpServer = null;
    this.wss = null;
    this.tray = null;
  }

  isActive() {
    if (!this.active) return false;
    if (this.expiresAt && Date.now() > this.expiresAt.getTime()) {
      this.deactivate('expired');
      return false;
    }
    return true;
  }

  getSecondsLeft() {
    if (!this.active || !this.expiresAt) return 0;
    const diff = Math.max(0, Math.floor((this.expiresAt.getTime() - Date.now()) / 1000));
    return diff;
  }

  activate(durationMs = this.defaultActivationMs) {
    if (this.activeTimer) {
      clearTimeout(this.activeTimer);
      this.activeTimer = null;
    }

    this.active = true;
    this.expiresAt = new Date(Date.now() + durationMs);

    this.activeTimer = setTimeout(() => {
      this.deactivate('expired');
    }, durationMs);

    if (this.tray) this.tray.update();
    if (this.onStateChange) this.onStateChange(this.getStatus());
    return this.getStatus();
  }

  deactivate(reason = REASON_DEACTIVATED) {
    if (this.activeTimer) {
      clearTimeout(this.activeTimer);
      this.activeTimer = null;
    }

    const wasActive = this.active;
    this.active = false;
    this.expiresAt = null;

    // Terminate all running sessions on deactivation
    for (const [id, session] of this.sessions.entries()) {
      session.terminate(reason);
      this.sessions.delete(id);
    }

    if (this.tray) this.tray.update();
    if (wasActive && this.onStateChange) {
      this.onStateChange(this.getStatus());
    }
    return this.getStatus();
  }

  getStatus() {
    return {
      schema: SCHEMA_VERSION,
      version: '1.0.0-node',
      pid: process.pid,
      instance: this.instanceId,
      started: this.startedAt.toISOString(),
      active: this.isActive(),
      expiresAt: this.active && this.expiresAt ? this.expiresAt.toISOString() : null,
      secondsLeft: this.getSecondsLeft(),
      sessions: this.sessions.size,
      maxSessions: this.maxSessions,
      elevated: this.elevated,
      currentUser: this.currentUser,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000)
    };
  }

  start(port = 0) {
    return new Promise((resolve, reject) => {
      this.stateDir = state.ensureDir();

      this.httpServer = http.createServer((req, res) => {
        this.handleHttp(req, res);
      });

      this.wss = new WebSocketServer({ noServer: true });

      this.httpServer.on('upgrade', (req, socket, head) => {
        this.handleUpgrade(req, socket, head);
      });

      this.httpServer.listen(port, '127.0.0.1', () => {
        this.port = this.httpServer.address().port;
        state.writeEndpoint(this.stateDir, {
          port: this.port,
          instance: this.instanceId,
          version: '1.0.0-node',
          elevated: this.elevated,
          started: this.startedAt.toISOString()
        });

        if (this.enableTray && process.platform === 'win32') {
          this.tray = new TrayIcon(this);
          this.tray.start();
        }

        resolve({ port: this.port, dir: this.stateDir, elevated: this.elevated });
      });

      this.httpServer.on('error', (err) => {
        reject(err);
      });
    });
  }

  handleHttp(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    // Refuse cross-origin web browser calls
    if (req.headers['origin']) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cross-origin requests are not allowed' }));
      return;
    }

    if (url.pathname === PATH_STATUS && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.getStatus()));
      return;
    }

    // Administrative operations require the private adminToken (provided only to the Tray Icon)
    const clientToken = req.headers['x-suwin-token'] || url.searchParams.get('token');
    const isAuthorized = clientToken && clientToken === this.adminToken;

    if (url.pathname === PATH_ACTIVATE && req.method === 'POST') {
      if (!isAuthorized) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Activation forbidden: The service can only be activated from the Tray Icon by a human.' }));
        return;
      }
      const durParam = url.searchParams.get('duration');
      const durMs = parseDuration(durParam, this.defaultActivationMs);
      const st = this.activate(durMs);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(st));
      return;
    }

    if (url.pathname === PATH_DEACTIVATE && req.method === 'POST') {
      if (!isAuthorized) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Deactivation forbidden: Use the Tray Icon.' }));
        return;
      }
      const st = this.deactivate('manual');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(st));
      return;
    }

    if (url.pathname === '/v1/quit' && req.method === 'POST') {
      if (!isAuthorized) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Quit forbidden: Use the Tray Icon.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => {
        this.stop().then(() => process.exit(0));
      }, 500);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    if (req.headers['origin']) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    if (url.pathname !== PATH_RUN) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!this.isActive()) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n\r\n');
      socket.destroy();
      return;
    }

    if (this.sessions.size >= this.maxSessions) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.handleClientSession(ws);
    });
  }

  handleClientSession(ws) {
    let session = null;
    let isAlive = true;

    const pingTimer = setInterval(() => {
      if (!isAlive) {
        clearInterval(pingTimer);
        if (session) session.terminate('keepalive_timeout');
        ws.terminate();
        return;
      }
      isAlive = false;
      ws.ping();
    }, KEEPALIVE_INTERVAL_MS);

    ws.on('pong', () => {
      isAlive = true;
    });

    ws.once('message', (firstData, isBinary) => {
      if (isBinary) {
        ws.send(JSON.stringify({
          type: TYPE_ERROR,
          code: CODE_BAD_REQUEST,
          message: 'First frame must be text start request'
        }));
        ws.close();
        return;
      }

      let startReq;
      try {
        startReq = JSON.parse(firstData.toString());
      } catch (err) {
        ws.send(JSON.stringify({
          type: TYPE_ERROR,
          code: CODE_BAD_REQUEST,
          message: 'Malformed JSON start request'
        }));
        ws.close();
        return;
      }

      if (startReq.type !== TYPE_START || !Array.isArray(startReq.argv)) {
        ws.send(JSON.stringify({
          type: TYPE_ERROR,
          code: CODE_BAD_REQUEST,
          message: 'Expected type: "start" with argv array'
        }));
        ws.close();
        return;
      }

      try {
        session = new Session({
          argv: startReq.argv,
          shell: startReq.shell,
          cwd: startReq.cwd,
          tty: Boolean(startReq.tty),
          cols: startReq.cols,
          rows: startReq.rows,
          timeoutMs: startReq.timeoutMs
        }, {
          onStdout: (chunk) => {
            if (ws.readyState === WebSocket.OPEN) {
              const frame = Buffer.allocUnsafe(1 + chunk.length);
              frame[0] = CHAN_STDOUT;
              chunk.copy(frame, 1);
              ws.send(frame, { binary: true });
            }
          },
          onStderr: (chunk) => {
            if (ws.readyState === WebSocket.OPEN) {
              const frame = Buffer.allocUnsafe(1 + chunk.length);
              frame[0] = CHAN_STDERR;
              chunk.copy(frame, 1);
              ws.send(frame, { binary: true });
            }
          },
          onExit: ({ code, reason }) => {
            clearInterval(pingTimer);
            this.sessions.delete(session.id);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: TYPE_EXIT,
                code: code,
                reason: reason
              }), () => {
                ws.close(1000, 'done');
              });
            }
          }
        });

        const startedInfo = session.start();
        this.sessions.set(session.id, session);

        ws.send(JSON.stringify({
          type: TYPE_STARTED,
          sessionId: startedInfo.id,
          pid: startedInfo.pid,
          mode: startedInfo.mode,
          command: startedInfo.command,
          cwd: startedInfo.cwd
        }));
      } catch (err) {
        clearInterval(pingTimer);
        ws.send(JSON.stringify({
          type: TYPE_ERROR,
          code: CODE_SPAWN_FAILED,
          message: err.message
        }));
        ws.close();
        return;
      }

      // Subsequent messages from client
      ws.on('message', (data, isBin) => {
        if (!session) return;

        if (isBin) {
          const buf = Buffer.from(data);
          const channel = buf[0];
          const payload = buf.subarray(1);
          if (channel === CHAN_STDIN || channel === CHAN_STDERR_ALIAS) {
            session.writeStdin(payload);
          }
        } else {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === TYPE_INTERRUPT) {
              session.interrupt();
            } else if (msg.type === TYPE_TERMINATE) {
              session.terminate();
            } else if (msg.type === TYPE_STDIN_EOF) {
              session.endStdin();
            } else if (msg.type === TYPE_RESIZE) {
              session.resize(msg.cols, msg.rows);
            }
          } catch {
            // Ignore malformed control frame
          }
        }
      });
    });

    ws.on('close', () => {
      clearInterval(pingTimer);
      if (session) {
        session.terminate('client_closed');
        this.sessions.delete(session.id);
      }
    });

    ws.on('error', () => {
      clearInterval(pingTimer);
      if (session) {
        session.terminate('client_error');
        this.sessions.delete(session.id);
      }
    });
  }

  stop() {
    return new Promise((resolve) => {
      this.deactivate(REASON_SERVICE_EXIT);

      if (this.tray) {
        try {
          this.tray.destroy();
        } catch {}
        this.tray = null;
      }

      if (this.stateDir) {
        state.removeEndpoint(this.stateDir);
      }

      if (this.wss) {
        this.wss.close();
      }

      if (this.httpServer) {
        this.httpServer.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
