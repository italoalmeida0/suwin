import { WebSocket } from 'ws';
import {
  SCHEMA_VERSION, PATH_STATUS, PATH_RUN, PATH_ACTIVATE, PATH_DEACTIVATE,
  CHAN_STDOUT, CHAN_STDERR, CHAN_STDIN,
  TYPE_START, TYPE_STARTED, TYPE_EXIT, TYPE_ERROR, TYPE_INTERRUPT, TYPE_TERMINATE, TYPE_STDIN_EOF, TYPE_STDIN_ACK, TYPE_RESIZE,
  EXIT_INTERRUPTED, validateStartRequest
} from './protocol.js';
import * as state from './state.js';

export class SuwinClientError extends Error {
  constructor(message, code) { super(message); this.name = 'SuwinClientError'; this.code = code; }
}

function endpoint() {
  const item = state.readEndpoint();
  if (!item) throw new SuwinClientError('suwin service is not running (start it with "suwinsvc")', 'NOT_RUNNING');
  return item.endpoint;
}

export async function getStatus({ timeoutMs = 3000 } = {}) {
  const ep = endpoint();
  try {
    const response = await fetch(`http://127.0.0.1:${ep.port}${PATH_STATUS}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new SuwinClientError(`Service responded with HTTP ${response.status}`, 'HTTP_ERROR');
    const status = await response.json();
    if (status.schema !== SCHEMA_VERSION || status.instance !== ep.instance || status.pid !== ep.pid) {
      throw new SuwinClientError('The endpoint belongs to a different service instance', 'STALE_ENDPOINT');
    }
    return { ...status, port: ep.port };
  } catch (error) {
    if (error instanceof SuwinClientError) throw error;
    throw new SuwinClientError(`Cannot reach suwin service on port ${ep.port}: ${error.message}`, 'UNREACHABLE');
  }
}

// Administrative APIs require the supervisor's private in-memory token. The
// execution client never discovers or saves this token, and cannot self-authorize.
async function adminRequest(route, adminToken) {
  if (!adminToken) throw new SuwinClientError('Use the Tray Icon to authorize administrative operations', 'AUTH_REQUIRED');
  const ep = endpoint();
  const response = await fetch(`http://127.0.0.1:${ep.port}${route}`, {
    method: 'POST', headers: { 'x-suwin-token': adminToken }, signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new SuwinClientError(`Administrative request refused (HTTP ${response.status})`, 'HTTP_ERROR');
  return response.json();
}

export function activateService(duration = '15m', adminToken) {
  return adminRequest(`${PATH_ACTIVATE}?duration=${encodeURIComponent(duration)}`, adminToken);
}

export function deactivateService(adminToken) { return adminRequest(PATH_DEACTIVATE, adminToken); }

export function runCommand(options = {}) {
  return new Promise((resolve, reject) => {
    let ep;
    try { ep = endpoint(); } catch (error) { reject(error); return; }
    const {
      argv = [], shell = false, cwd = process.cwd(), env = { ...process.env }, tty = false,
      cols = Math.min(500, process.stdout?.columns || 80), rows = Math.min(500, process.stdout?.rows || 24),
      timeoutMs = 0, stdin = null, stdout = process.stdout, stderr = process.stderr,
      onStarted = null, signal = null, keepAliveIntervalMs = 15000
    } = options;
    const start = { type: TYPE_START, schema: SCHEMA_VERSION, argv, shell, cwd, env, tty, cols, rows, timeoutMs };
    try { validateStartRequest(start); } catch (error) { reject(new SuwinClientError(error.message, 'BAD_REQUEST')); return; }
    if (!Number.isSafeInteger(keepAliveIntervalMs) || keepAliveIntervalMs <= 0) return reject(new SuwinClientError('Invalid keepalive interval', 'BAD_REQUEST'));
    if (signal?.aborted) return reject(new SuwinClientError('Command cancelled', 'ABORTED'));

    const ws = new WebSocket(`ws://127.0.0.1:${ep.port}${PATH_RUN}`, { handshakeTimeout: 3000, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });
    let settled = false, started = false, interrupts = 0, heartbeat = null, lastActivity = Date.now();
    let mode = null;
    let inputPaused = false;
    const inputWasFlowing = stdin?.readableFlowing;
    let acknowledgeInput = false, inFlightInput = 0, inputEnded = false, eofSent = false;
    const inputQueue = [];
    const drains = new Map();
    const cleanup = () => {
      clearInterval(heartbeat);
      process.off('SIGINT', interrupt);
      process.stdout?.off('resize', resize);
      stdin?.off('data', input);
      stdin?.off('end', endInput);
      stdin?.off('error', inputError);
      stdout?.off?.('error', outputError);
      stderr?.off?.('error', outputError);
      signal?.removeEventListener('abort', abort);
      for (const [stream, listener] of drains) stream.off('drain', listener);
      drains.clear();
      if (stdin === process.stdin) stdin.pause();
      else if (inputWasFlowing) stdin?.resume();
      else stdin?.pause();
      inputQueue.length = 0;
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) { ws.terminate(); reject(error); }
      else {
        if (ws.readyState === WebSocket.OPEN) ws.close();
        const closeTimer = setTimeout(() => ws.terminate(), 1000);
        closeTimer.unref();
        ws.once('close', () => clearTimeout(closeTimer));
        resolve(result);
      }
    };
    const fail = (message, code) => finish(new SuwinClientError(message, code));
    const control = message => { if (ws.readyState === WebSocket.OPEN && !settled) ws.send(JSON.stringify(message)); };
    const interrupt = () => {
      if (mode === 'pty') { control({ type: TYPE_INTERRUPT }); return; }
      if (++interrupts === 1) control({ type: TYPE_INTERRUPT });
      else {
        control({ type: TYPE_TERMINATE });
        finish(null, { code: EXIT_INTERRUPTED, reason: 'interrupted' });
        ws.terminate();
      }
    };
    const resize = () => control({ type: TYPE_RESIZE, cols: Math.min(500, process.stdout.columns || 80), rows: Math.min(500, process.stdout.rows || 24) });
    const flushInput = () => {
      if (settled || ws.readyState !== WebSocket.OPEN) return;
      while (inputQueue.length && (!acknowledgeInput || inFlightInput < 256 * 1024)) {
        const chunk = inputQueue.shift();
        inFlightInput += acknowledgeInput ? chunk.length : 0;
        ws.send(Buffer.concat([Buffer.from([CHAN_STDIN]), chunk]), { binary: true }, error => {
          if (error) fail(`Cannot send input: ${error.message}`, 'SOCKET_ERROR');
        });
      }
      if ((inputQueue.length || inFlightInput >= 256 * 1024) && !inputPaused) {
        stdin?.pause();
        inputPaused = true;
      } else if (!inputQueue.length && inFlightInput < 128 * 1024 && inputPaused) {
        inputPaused = false;
        stdin?.resume();
      }
      if (inputEnded && !inputQueue.length && !eofSent) {
        eofSent = true;
        control({ type: TYPE_STDIN_EOF });
      }
    };
    const sendInput = chunk => {
      for (let offset = 0; offset < chunk.length; offset += 32768) inputQueue.push(chunk.subarray(offset, offset + 32768));
      flushInput();
    };
    const input = value => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      // Preserve all terminal bytes and their order, including repeated Ctrl+C.
      // Disconnect, explicit cancellation and timeout own process-tree cleanup.
      sendInput(chunk);
    };
    const endInput = () => { inputEnded = true; flushInput(); };
    const inputError = error => fail(`Cannot read input: ${error.message}`, 'STDIN_ERROR');
    const outputError = error => fail(`Cannot write output: ${error.message}`, 'STDOUT_ERROR');
    const abort = () => fail('Command cancelled', 'ABORTED');
    signal?.addEventListener('abort', abort, { once: true });
    stdout?.on?.('error', outputError);
    if (stderr !== stdout) stderr?.on?.('error', outputError);

    const output = (stream, payload) => {
      if (!stream) return;
      if (stream.write(payload) === false && stream.once && !drains.has(stream)) {
        ws.pause();
        const drained = () => { drains.delete(stream); if (!drains.size && !settled) ws.resume(); };
        drains.set(stream, drained);
        stream.once('drain', drained);
      }
    };
    ws.on('open', () => {
      ws.send(JSON.stringify(start));
      heartbeat = setInterval(() => {
        if (ws.isPaused) { lastActivity = Date.now(); return; }
        if (Date.now() - lastActivity > keepAliveIntervalMs * 2) return fail('The supervisor service stopped responding', 'UNREACHABLE');
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, keepAliveIntervalMs);
    });
    ws.on('pong', () => { lastActivity = Date.now(); });
    ws.on('ping', () => { lastActivity = Date.now(); });
    ws.on('message', (data, binary) => {
      if (settled) return;
      lastActivity = Date.now();
      try {
        if (binary) {
          if (!started || !data.length) throw new Error('Unexpected output frame');
          if (data[0] === CHAN_STDOUT) output(stdout, data.subarray(1));
          else if (data[0] === CHAN_STDERR) output(stderr, data.subarray(1));
          else throw new Error('Unknown output channel');
          return;
        }
        const msg = JSON.parse(data.toString());
        if (msg.type === TYPE_STARTED && !started) {
          started = true;
          mode = msg.mode;
          acknowledgeInput = Boolean(msg.stdinAck);
          onStarted?.(msg);
          if (settled) return;
          process.on('SIGINT', interrupt);
          if (tty && process.stdout?.isTTY) process.stdout.on('resize', resize);
          if (stdin && !stdin.readableEnded) {
            stdin.on('data', input);
            stdin.once('end', endInput);
            stdin.once('error', inputError);
            stdin.resume();
          } else endInput();
        } else if (msg.type === TYPE_STDIN_ACK) {
          if (!Number.isInteger(msg.bytes) || msg.bytes < 0 || (acknowledgeInput && msg.bytes > inFlightInput)) throw new Error('Invalid stdin acknowledgement');
          inFlightInput -= acknowledgeInput ? msg.bytes : 0;
          flushInput();
        } else if (msg.type === TYPE_EXIT) {
          if (!started || !Number.isInteger(msg.code)) throw new Error('Invalid exit report');
          finish(null, { code: msg.code, reason: msg.reason || 'exited' });
        } else if (msg.type === TYPE_ERROR) fail(msg.message || 'Command refused', msg.code);
        else throw new Error('Unexpected control frame');
      } catch (error) { fail(`Invalid session response: ${error.message}`, 'PROTOCOL_ERROR'); }
    });
    ws.on('error', error => fail(`WebSocket error: ${error.message}`, 'SOCKET_ERROR'));
    ws.on('close', () => { if (!settled) fail('The supervisor connection closed before reporting the command exit', 'DISCONNECTED'); });
  });
}
