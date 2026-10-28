// state.js - Endpoint discovery, directories and elevation checks
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { isWindowsElevated, acquireWindowsServiceLock } from './windows.js';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from './protocol.js';
import { VERSION } from './version.js';

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
    return isWindowsElevated();
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

export function acquireServiceLock(dir, instance) {
  if (process.platform === 'win32') {
    const key = crypto.createHash('sha256').update(fs.realpathSync(dir).toLowerCase()).digest('hex');
    return acquireWindowsServiceLock(`Global\\suwin-${key}`);
  }
  const file = path.join(dir, 'service.lock');
  const alive = pid => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code === 'EPERM'; }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, instance }));
      fs.closeSync(fd);
      fd = undefined;
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).instance === instance) fs.unlinkSync(file);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (error.code !== 'EEXIST') throw error;
      // An empty lock may be in the middle of being written by another process.
      let owner;
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { throw new Error('Another suwin service may be starting; try again'); }
      if (alive(owner.pid)) throw new Error('Another suwin service is already running');
      try { fs.unlinkSync(file); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
    }
  }
  throw new Error('Could not acquire the suwin service lock');
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
    version: info.version || VERSION,
    user: getCurrentUser(),
    elevated: info.elevated ?? isElevated(),
    dir: dir,
    started: info.started || new Date().toISOString(),
    home: info.home || getSuwinHome(),
    stopToken: info.stopToken
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
        if (data?.schema === SCHEMA_VERSION && Number.isInteger(data.port) && data.port > 0 && data.port <= 65535 &&
            Number.isInteger(data.pid) && data.pid > 0 && typeof data.instance === 'string' && data.instance) {
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
export function removeEndpoint(dir, instance) {
  const dirs = dir ? [dir] : candidateDirs();
  for (const d of dirs) {
    const filePath = path.join(d, ENDPOINT_FILE);
    try {
      if (instance && JSON.parse(fs.readFileSync(filePath, 'utf8')).instance !== instance) continue;
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore cleanup error
    }
  }
}
