import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Session } from '../src/runner.js';
import koffi from 'koffi';
import { validateRoot, changePathValue } from '../src/setup.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function waitFor(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(50); }
  assert.fail('Timed out waiting for setup/service cleanup');
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suwin-setup-test-'));
  t.after(() => {
    const target = fs.realpathSync(dir);
    assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(target).startsWith('suwin-setup-test-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  });
  return dir;
}
function environment(root) { return { ...process.env, SUWIN_HOME: root, SUWIN_DIR: path.join(root, 'state'), SUWIN_AUTOACTIVATE: '' }; }
async function run(script, args, root, success = true) {
  let output = '';
  const argv = script.endsWith('.cmd') ? [script, ...args] : [process.execPath, script, ...args];
  const command = new Session({ argv, env: environment(root), timeoutMs: 120000 }, {
    onStdout: data => { output += data; }, onStderr: data => { output += data; }
  });
  command.start();
  const result = await command.done;
  if (success) assert.equal(result.code, 0, output);
  else assert.notEqual(result.code, 0, 'Setup should report the failure');
  return output;
}
async function daemon(root, active = true) {
  const child = spawn(process.execPath, [path.join(root, 'node', 'bin', 'suwinsvc.js'), '--daemon', '--no-tray', ...(active ? ['--active', '60s'] : [])],
    { env: environment(root), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.on('error', () => {});
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  await waitFor(() => {
    if (child.exitCode !== null) assert.fail(errors);
    return fs.existsSync(path.join(root, 'state', 'endpoint.json'));
  });
  return child;
}
async function commandTree(root) {
  const code = 'const{spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{windowsHide:true,stdio:"ignore"});console.log("ROOT:"+process.pid);c.on("spawn",()=>console.log("CHILD:"+c.pid));setInterval(()=>{},1000)';
  const client = spawn(process.execPath, [path.join(root, 'node', 'bin', 'suwin.js'), '--no-tty', process.execPath, '-e', code], { env: environment(root), windowsHide: true });
  let output = '', errors = '';
  client.on('error', () => {});
  client.stdout.on('data', data => { output += data; });
  client.stderr.on('data', data => { errors += data; });
  client.stdin.end();
  await waitFor(() => {
    if (client.exitCode !== null) assert.fail(errors || output);
    return /CHILD:\d+/.test(output);
  });
  return { client, rootPid: Number(/ROOT:(\d+)/.exec(output)[1]), childPid: Number(/CHILD:(\d+)/.exec(output)[1]) };
}

test('setup refuses unrelated directories and links', { skip: !windows }, t => {
  const dir = temporary(t);
  assert.throws(() => validateRoot(path.parse(dir).root));
  assert.throws(() => validateRoot(os.homedir()));
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'keep me');
  assert.throws(() => validateRoot(dir), /not an empty directory/);
  assert.equal(fs.readFileSync(path.join(dir, 'unrelated.txt'), 'utf8'), 'keep me');
});

test('PATH changes are idempotent and preserve unrelated entries', () => {
  const bin = 'C:\\Users\\Example\\.suwin\\bin';
  const original = 'C:\\Windows;;C:\\Tools';
  const added = changePathValue(original, bin, true);
  assert.equal(changePathValue(added, bin, true), added);
  assert.equal(changePathValue(added, bin, false), original);
});

test('install, live update and self-uninstall stop commands and preserve user data', { skip: !windows, timeout: 180000 }, async t => {
  const parent = temporary(t);
  const root = path.join(parent, "Suwin O'Brien & Test");
  const children = [];
  try {
    await run(path.join(project, 'scripts', 'install.js'), ['--root', root, '--no-path'], root);
    assert.match(await run(path.join(root, 'bin', 'suwin.cmd'), ['--version'], root), /suwin 1\.0\.0/);
    assert.equal(fs.existsSync(path.join(root, 'state', 'endpoint.json')), false, 'Installation must not start the supervisor');
    const lockHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(lockHash(path.join(root, 'node', 'package-lock.json')), lockHash(path.join(project, 'package-lock.json')));
    fs.writeFileSync(path.join(root, 'state', 'user-data.txt'), 'preserved');
    fs.writeFileSync(path.join(root, 'node', 'node_modules', 'stale-dependency.txt'), 'must disappear on update');
    // Fail after the new app has been staged/swapped: a locked metadata file
    // must leave the original app and its manifest recoverable.
    const kernel = koffi.load('kernel32.dll');
    const open = kernel.func('void* __stdcall CreateFileW(const char16_t*, uint32, uint32, void*, uint32, uint32, void*)');
    const close = kernel.func('int __stdcall CloseHandle(void*)');
    const markerFile = path.join(root, 'install.json');
    const oldMarker = fs.readFileSync(markerFile, 'utf8');
    const handle = open(markerFile, 0x80000000, 1, null, 3, 0x80, null);
    assert.ok(handle && koffi.address(handle) !== 0xffffffffffffffffn);
    try { await run(path.join(project, 'scripts', 'install.js'), ['--root', root, '--no-path'], root, false); }
    finally { close(handle); }
    assert.equal(fs.readFileSync(markerFile, 'utf8'), oldMarker);
    assert.equal(fs.existsSync(path.join(root, 'node', 'node_modules', 'stale-dependency.txt')), true);
    const first = await daemon(root);
    children.push(first);
    const task = await commandTree(root);
    children.push(task.client);
    const ep = JSON.parse(fs.readFileSync(path.join(root, 'state', 'endpoint.json')));
    const forbidden = await fetch(`http://127.0.0.1:${ep.port}/v1/activate`, { method: 'POST', headers: { 'x-suwin-token': ep.stopToken } });
    assert.equal(forbidden.status, 403, 'The setup capability must never activate the service');
    const endpointFile = path.join(root, 'state', 'endpoint.json');
    fs.writeFileSync(endpointFile, JSON.stringify({ ...ep, stopToken: 'invalid' }));
    await run(path.join(project, 'scripts', 'install.js'), ['--root', root, '--no-path'], root, false);
    assert.ok(alive(first.pid) && alive(task.rootPid) && alive(task.childPid));
    assert.equal(fs.existsSync(path.join(root, 'node', 'node_modules', 'stale-dependency.txt')), true);
    fs.writeFileSync(endpointFile, JSON.stringify(ep));
    await run(path.join(project, 'scripts', 'install.js'), ['--root', root, '--no-path'], root);
    await waitFor(() => !alive(first.pid) && !alive(task.rootPid) && !alive(task.childPid) && !alive(task.client.pid));
    assert.equal(fs.readFileSync(path.join(root, 'state', 'user-data.txt'), 'utf8'), 'preserved');
    assert.equal(fs.existsSync(path.join(root, 'node', 'node_modules', 'stale-dependency.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'state', 'endpoint.json')), false);
    const second = await daemon(root, false);
    children.push(second);
    const secondEp = JSON.parse(fs.readFileSync(path.join(root, 'state', 'endpoint.json')));
    const status = await (await fetch(`http://127.0.0.1:${secondEp.port}/v1/status`)).json();
    assert.equal(status.active, false);
    await run(path.join(root, 'bin', 'uninstall-suwin.cmd'), [], root);
    await waitFor(() => !alive(second.pid));
    assert.equal(fs.existsSync(root), false, 'Self-uninstall must remove the installation completely');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }
});

test('CI exercises the real per-user PATH registration and removal', { skip: !windows || !process.env.CI, timeout: 120000 }, async t => {
  const root = path.join(temporary(t), 'path-install');
  try { await run(path.join(project, 'scripts', 'install.js'), ['--root', root], root); }
  finally { if (fs.existsSync(path.join(root, 'install.json'))) await run(path.join(project, 'scripts', 'uninstall.js'), ['--root', root], root); }
});
