// protocol.js - Protocol constants and helpers for Security Undertaking Windows (suwin)
export const SCHEMA_VERSION = 1;
export const MAX_ACTIVATION_MS = 24 * 60 * 60 * 1000;
export const MAX_TIMEOUT_MS = 0x7fffffff;

export const PATH_STATUS = '/v1/status';
export const PATH_RUN = '/v1/run';
export const PATH_ACTIVATE = '/v1/activate';
export const PATH_DEACTIVATE = '/v1/deactivate';

// Binary WebSocket channel prefixes (first byte of binary frames)
export const CHAN_STDOUT = 0;
export const CHAN_STDERR = 1;
export const CHAN_STDIN = 2;
export const CHAN_STDERR_ALIAS = 3;

// JSON message types
export const TYPE_START = 'start';
export const TYPE_STARTED = 'started';
export const TYPE_EXIT = 'exit';
export const TYPE_ERROR = 'error';
export const TYPE_NOTICE = 'notice';
export const TYPE_RESIZE = 'resize';
export const TYPE_STDIN_EOF = 'stdin_eof';
export const TYPE_STDIN_ACK = 'stdin_ack';
export const TYPE_INTERRUPT = 'interrupt';
export const TYPE_TERMINATE = 'terminate';

// Exit reasons
export const REASON_EXITED = 'exited';
export const REASON_INTERRUPTED = 'interrupted';
export const REASON_TERMINATED = 'terminated';
export const REASON_TIMEOUT = 'timeout';
export const REASON_DEACTIVATED = 'deactivated';
export const REASON_SERVICE_EXIT = 'service_exit';

// Synthetic exit codes
export const EXIT_INTERRUPTED = 130;
export const EXIT_TERMINATED = 143;
export const EXIT_TIMEOUT = 124;

// Error codes
export const CODE_INACTIVE = 'service_inactive';
export const CODE_BUSY = 'too_many_sessions';
export const CODE_BAD_REQUEST = 'bad_request';
export const CODE_SPAWN_FAILED = 'spawn_failed';
export const CODE_UNSUPPORTED = 'unsupported';
export const CODE_SHUTTING_DOWN = 'shutting_down';

/**
 * Parses duration string (e.g. "15m", "30s", "1h", "500ms") into milliseconds.
 * Returns defaultMs if invalid or not specified.
 */
export function parseDuration(val, defaultMs = 0) {
  if (val === undefined || val === null || val === '') return defaultMs;
  if (typeof val === 'number') return Number.isSafeInteger(val) && val > 0 && val <= MAX_TIMEOUT_MS ? val : defaultMs;

  const str = String(val).trim();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(str);
  if (!match) return defaultMs;

  const num = parseFloat(match[1]);
  const unit = (match[2] || 's').toLowerCase();

  const multiplier = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  const result = Math.round(num * multiplier);
  return Number.isSafeInteger(result) && result > 0 && result <= MAX_TIMEOUT_MS ? result : defaultMs;
}

export function validateStartRequest(req) {
  if (!req || req.type !== TYPE_START || req.schema !== SCHEMA_VERSION) throw new Error('Incompatible or missing protocol schema');
  if (!Array.isArray(req.argv) || req.argv.length === 0 || req.argv.length > 4096 ||
      req.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !req.argv[0]) throw new Error('Expected a nonempty argv array of strings');
  if (req.cwd !== undefined && (typeof req.cwd !== 'string' || !req.cwd || req.cwd.includes('\0'))) throw new Error('Invalid working directory');
  for (const key of ['shell', 'tty']) if (req[key] !== undefined && typeof req[key] !== 'boolean') throw new Error(`Invalid ${key} flag`);
  if (req.timeoutMs !== undefined && (!Number.isSafeInteger(req.timeoutMs) || req.timeoutMs < 0 || req.timeoutMs > MAX_TIMEOUT_MS)) throw new Error('Invalid command timeout');
  for (const key of ['cols', 'rows']) if (req[key] !== undefined && (!Number.isInteger(req[key]) || req[key] < 1 || req[key] > 500)) throw new Error(`Invalid terminal ${key}`);
  if (req.env !== undefined) {
    if (!req.env || typeof req.env !== 'object' || Array.isArray(req.env) || Object.keys(req.env).length > 4096) throw new Error('Invalid environment');
    for (const [key, value] of Object.entries(req.env)) {
      if (!key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid environment variable');
    }
  }
  return req;
}

/**
 * Formats milliseconds into human readable string (e.g. "14m 20s" or "45s")
 */
export function formatDuration(ms) {
  if (ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}
