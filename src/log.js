import fs from 'node:fs';
import path from 'node:path';

export function createAuditLog(dir, { maxBytes = 1024 * 1024 } = {}) {
  const file = path.join(dir, 'suwinsvc.log');
  fs.appendFileSync(file, '', { mode: 0o600 });
  function write(level, event, fields = {}) {
    const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }) + '\n';
    if (fs.statSync(file).size + Buffer.byteLength(line) > maxBytes) {
      fs.rmSync(file + '.1', { force: true });
      fs.renameSync(file, file + '.1');
    }
    fs.appendFileSync(file, line, { mode: 0o600 });
  }
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields)
  };
}
