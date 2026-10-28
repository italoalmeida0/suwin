import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

for (const dir of ['src', 'bin', 'scripts', 'test']) {
  for (const file of fs.readdirSync(dir, { recursive: true })) {
    if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', path.join(dir, file)], { stdio: 'inherit', windowsHide: true });
  }
}
console.log('JavaScript syntax checks passed.');
