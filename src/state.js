// state.js - Endpoint discovery, directories and elevation checks
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from './protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ENDPOINT_FILE = 'endpoint.json';
export const LOG_FILE = 'suwinsvc.log';
export const DIR_ENV_VAR = 'SUWIN_DIR';

/**
 * Returns the suwin installation root (~/.suwin).
 */
export function getSuwinHome() {
  if (process.env.SUWIN_HOME) return process.env.SUWIN_HOME;
  // If running from an installed tree ~/.suwin/node/src/state.js
  const candidate = path.resolve(__dirname, '../..');
  if (fs.existsSync(path.join(candidate, 'bin', 'suwin.cmd')) || fs.existsSync(path.join(candidate, 'bin', 'suwin.js'))) {
    return candidate;
  }
  return path.join(os.homedir(), '.suwin');
}

/**
 * Checks whether the current Node process is running with elevated privileges (Administrator).
 */
export function isElevated() {
  if (process.platform !== 'win32') {
    return typeof process.getuid === 'function' && process.getuid() === 0;
  }
  try {
    // On Windows, 'net session' succeeds (exit code 0) only if running as Administrator.
    execSync('net session', { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets the current username.
 */
export function getCurrentUser() {
  try {
    return os.userInfo().username || process.env.USERNAME || process.env.USER || 'unknown';
  } catch {
    return process.env.USERNAME || process.env.USER || 'unknown';
  }
}

export function getPrimaryDir() {
  if (process.env[DIR_ENV_VAR]) {
    return process.env[DIR_ENV_VAR];
  }
  return path.join(getSuwinHome(), 'state');
}

export function getFallbackDir() {
  return getPrimaryDir();
}

export function candidateDirs() {
  const primary = path.normalize(getPrimaryDir());
  const home = path.normalize(getSuwinHome());
  const dirs = [primary];
  if (primary.toLowerCase() !== home.toLowerCase()) {
    dirs.push(home);
  }
  return dirs;
}

/**
 * Ensures a state directory exists inside the installation folder.
 */
export function ensureDir() {
  const dir = getPrimaryDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    const fallback = path.join(getSuwinHome(), 'state');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

/**
 * Writes the endpoint discovery file atomically.
 */
export function writeEndpoint(dir, info) {
  const targetFile = path.join(dir, ENDPOINT_FILE);
  const tempFile = path.join(dir, `${ENDPOINT_FILE}.${process.pid}.tmp`);

  const payload = {
    schema: SCHEMA_VERSION,
    port: info.port,
    pid: process.pid,
    instance: info.instance,
    version: info.version || '1.0.0',
    user: getCurrentUser(),
    elevated: info.elevated ?? isElevated(),
    dir: dir,
    started: info.started || new Date().toISOString()
  };

  fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tempFile, targetFile);
  return payload;
}

/**
 * Reads and parses the endpoint.json file from candidate directories.
 */
export function readEndpoint() {
  for (const dir of candidateDirs()) {
    const filePath = path.join(dir, ENDPOINT_FILE);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        if (data && data.port) {
          return { endpoint: data, filePath };
        }
      } catch {
        // Corrupted or being written, continue
      }
    }
  }
  return null;
}

/**
 * Removes the endpoint.json file.
 */
export function removeEndpoint(dir) {
  const dirs = dir ? [dir] : candidateDirs();
  for (const d of dirs) {
    const filePath = path.join(d, ENDPOINT_FILE);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore cleanup error
    }
  }
}
