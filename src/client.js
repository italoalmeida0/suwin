// client.js - Client library for executing commands via suwin service
import { WebSocket } from 'ws';
import {
  SCHEMA_VERSION,
  PATH_STATUS,
  PATH_RUN,
  PATH_ACTIVATE,
  PATH_DEACTIVATE,
  CHAN_STDOUT,
  CHAN_STDERR,
  CHAN_STDIN,
  TYPE_START,
  TYPE_STARTED,
  TYPE_EXIT,
  TYPE_ERROR,
  TYPE_INTERRUPT,
  TYPE_TERMINATE,
  TYPE_STDIN_EOF,
  TYPE_RESIZE
} from './protocol.js';
import * as state from './state.js';

export class SuwinClientError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SuwinClientError';
    this.code = code;
  }
}

/**
 * Gets the current status of the running suwin service.
 */
export async function getStatus() {
  const item = state.readEndpoint();
  if (!item) {
    throw new SuwinClientError('suwin service is not running (endpoint.json not found)', 'NOT_RUNNING');
  }

  const url = `http://127.0.0.1:${item.endpoint.port}${PATH_STATUS}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new SuwinClientError(`Service responded with HTTP ${res.status}`, 'HTTP_ERROR');
    }
    return await res.json();
  } catch (err) {
    if (err instanceof SuwinClientError) throw err;
    throw new SuwinClientError(`Cannot connect to suwin service on port ${item.endpoint.port}: ${err.message}`, 'UNREACHABLE');
  }
}

/**
 * Activates the running suwin service for a given duration (e.g. "15m", "1h").
 */
export async function activateService(duration = '15m') {
  const item = state.readEndpoint();
  if (!item) {
    throw new SuwinClientError('suwin service is not running', 'NOT_RUNNING');
  }

  const url = `http://127.0.0.1:${item.endpoint.port}${PATH_ACTIVATE}?duration=${encodeURIComponent(duration)}`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) {
    throw new SuwinClientError(`Failed to activate service (HTTP ${res.status})`, 'HTTP_ERROR');
  }
  return await res.json();
}

/**
 * Deactivates the running suwin service immediately.
 */
export async function deactivateService() {
  const item = state.readEndpoint();
  if (!item) {
    throw new SuwinClientError('suwin service is not running', 'NOT_RUNNING');
  }

  const url = `http://127.0.0.1:${item.endpoint.port}${PATH_DEACTIVATE}`;
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) {
    throw new SuwinClientError(`Failed to deactivate service (HTTP ${res.status})`, 'HTTP_ERROR');
  }
  return await res.json();
}

/**
 * Executes a command with administrator privileges through the suwin service.
 */
export function runCommand(options = {}) {
  return new Promise((resolve, reject) => {
    const item = state.readEndpoint();
    if (!item) {
      return reject(new SuwinClientError('suwin service is not running (start it with "suwinsvc")', 'NOT_RUNNING'));
    }

    const {
      argv = [],
      shell = false,
      cwd = process.cwd(),
      tty = false,
      cols = process.stdout?.columns || 80,
      rows = process.stdout?.rows || 24,
      timeoutMs = 0,
      stdin = null,
      stdout = process.stdout,
      stderr = process.stderr,
      onStarted = null
    } = options;

    if (!argv || argv.length === 0) {
      return reject(new SuwinClientError('No command specified in argv', 'EMPTY_ARGV'));
    }

    const wsUrl = `ws://127.0.0.1:${item.endpoint.port}${PATH_RUN}`;
    const ws = new WebSocket(wsUrl);

    let sigintHandler = null;
    let resizeHandler = null;

    const cleanup = () => {
      if (sigintHandler) {
        process.off('SIGINT', sigintHandler);
        sigintHandler = null;
      }
      if (resizeHandler && process.stdout?.off) {
        process.stdout.off('resize', resizeHandler);
        resizeHandler = null;
      }
    };

    ws.on('open', () => {
      // 1. Send start request
      const startReq = {
        type: TYPE_START,
        schema: SCHEMA_VERSION,
        argv: argv,
        shell: shell,
        cwd: cwd,
        tty: tty,
        cols: cols,
        rows: rows,
        timeoutMs: timeoutMs,
        client: {
          version: '1.0.0-node',
          pid: process.pid,
          user: state.getCurrentUser(),
          tty: tty
        }
      };

      ws.send(JSON.stringify(startReq));

      // 2. Intercept Ctrl+C
      sigintHandler = () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: TYPE_INTERRUPT }));
        }
      };
      process.on('SIGINT', sigintHandler);

      // 3. Handle terminal resize
      if (tty && process.stdout?.isTTY) {
        resizeHandler = () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: TYPE_RESIZE,
              cols: process.stdout.columns || 80,
              rows: process.stdout.rows || 24
            }));
          }
        };
        process.stdout.on('resize', resizeHandler);
      }

      // 4. Forward standard input
      if (stdin) {
        stdin.on('data', (chunk) => {
          if (ws.readyState === WebSocket.OPEN) {
            const frame = Buffer.allocUnsafe(1 + chunk.length);
            frame[0] = CHAN_STDIN;
            chunk.copy(frame, 1);
            ws.send(frame, { binary: true });
          }
        });

        stdin.on('end', () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: TYPE_STDIN_EOF }));
          }
        });
      }
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.from(data);
        const channel = buf[0];
        const payload = buf.subarray(1);

        if (channel === CHAN_STDOUT && stdout) {
          stdout.write(payload);
        } else if (channel === CHAN_STDERR && stderr) {
          stderr.write(payload);
        }
      } else {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === TYPE_STARTED && onStarted) {
            onStarted(msg);
          } else if (msg.type === TYPE_EXIT) {
            cleanup();
            resolve({
              code: msg.code ?? 0,
              reason: msg.reason || 'exited'
            });
          } else if (msg.type === TYPE_ERROR) {
            cleanup();
            reject(new SuwinClientError(msg.message, msg.code));
          }
        } catch {
          // Ignore parse errors on notice messages
        }
      }
    });

    ws.on('error', (err) => {
      cleanup();
      reject(new SuwinClientError(`WebSocket error: ${err.message}`, 'SOCKET_ERROR'));
    });

    ws.on('close', (code, reason) => {
      cleanup();
      resolve({ code: code === 1000 ? 0 : 1, reason: reason?.toString() || 'closed' });
    });
  });
}
