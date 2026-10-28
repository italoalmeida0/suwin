import fs from 'node:fs';
import path from 'node:path';

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export function assertNotMaintaining(dir) {
  const file = path.join(dir, 'maintenance.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw new Error('Installation maintenance is in progress'); }
  if (processAlive(data.pid)) throw new Error('Installation maintenance is in progress; start suwinsvc after setup finishes');
}
