import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const { version } = JSON.parse(fs.readFileSync('package.json'));
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error('The release tag must match package.json');
const dir = path.resolve('dist');
fs.mkdirSync(dir, { recursive: true });
const name = `suwin-${version}.zip`;
execFileSync('git', ['archive', '--format=zip', `--prefix=suwin-${version}/`, '--output', path.join(dir, name), 'HEAD'], { windowsHide: true, stdio: 'inherit' });
const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${digest}  ${name}\n`);
console.log(`Created dist/${name} and SHA256SUMS.txt`);
