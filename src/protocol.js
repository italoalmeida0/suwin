// protocol.js - Protocol constants and helpers for Security Undertaking Windows (suwin)
export const SCHEMA_VERSION = 1;

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
  if (typeof val === 'number') return val > 0 ? val : defaultMs;

  const str = String(val).trim();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(str);
  if (!match) return defaultMs;

  const num = parseFloat(match[1]);
  const unit = (match[2] || 's').toLowerCase();

  switch (unit) {
    case 'ms': return Math.round(num);
    case 's': return Math.round(num * 1000);
    case 'm': return Math.round(num * 60 * 1000);
    case 'h': return Math.round(num * 60 * 60 * 1000);
    case 'd': return Math.round(num * 24 * 60 * 60 * 1000);
    default: return defaultMs;
  }
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
