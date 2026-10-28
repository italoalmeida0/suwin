import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Readable, PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { SuwinServer } from '../src/server.js';
import { runCommand, getStatus, activateService } from '../src/client.js';
import { Session } from '../src/runner.js';
import { parseDuration, MAX_TIMEOUT_MS, MAX_ACTIVATION_MS } from '../src/protocol.js';
import { elevationScript, serviceArguments } from '../src/launch.js';
import { writeEndpoint } from '../src/state.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const noop = { write() { return true; } };
const nodeCommand = code => [process.execPath, '-e', code];
const startRequest = code => ({ type: 'start', schema: 1, argv: nodeCommand(code) });
function capture() {
  const chunks = [];
  return { write(chunk) { chunks.push(Buffer.from(chunk)); return true; }, text() { return Buffer.concat(chunks).toString(); } };
}
async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(20); }
  assert.fail('Timed out waiting for the expected process state');
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
async function temporary(t, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suwin-test-'));
  const previous = process.env.SUWIN_DIR;
  process.env.SUWIN_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.SUWIN_DIR;
    else process.env.SUWIN_DIR = previous;
    // Only remove the one directory created by this test, inside the OS temp dir.
    const target = fs.realpathSync(dir);
    assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(target).startsWith('suwin-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return callback(dir);
}
async function supervisor(t, callback, options = {}) {
  return temporary(t, async dir => {
    const server = new SuwinServer({ tray: false, ...options });
    await server.start();
    try { return await callback(server, dir); }
    finally { await server.stop(); }
  });
}
async function raw(server, options = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/run`, options);
  await once(ws, 'open');
  return ws;
}
async function frame(ws, value) {
  const received = once(ws, 'message');
  ws.send(JSON.stringify(value));
  const [data, binary] = await received;
  assert.equal(binary, false);
  return JSON.parse(data.toString());
}
function childTree() {
  return `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); c.on('spawn',()=>console.log('CHILD:'+c.pid)); setInterval(()=>{},1000);`;
}

function interactiveTree() {
  return childTree() + `process.stdin.setRawMode(true);let bytes=[];process.stdin.on('data',data=>{for(const byte of data){if(byte===113){console.log('BYTES:'+JSON.stringify(bytes));process.exit(37)}bytes.push(byte)}console.log('INPUT:'+JSON.stringify(bytes))});`;
}

test('suwin regression suite', { timeout: 120000 }, async t => {
  await t.test('duration parsing rejects zero, invalid and overflowing timers', () => {
    assert.equal(parseDuration('500ms'), 500);
    assert.equal(parseDuration('1.5m'), 90000);
    for (const value of ['0s', 'bogus', '-1s', '999999999d', Infinity, MAX_TIMEOUT_MS + 1]) assert.equal(parseDuration(value, 42), 42);
  });

  await t.test('manual startup is inactive and clients cannot self-authorize', async t => supervisor(t, async server => {
    const status = await getStatus();
    assert.equal(status.active, false);
    assert.equal(status.port, server.port);
    await assert.rejects(runCommand({ argv: nodeCommand('process.exit(0)') }));
    await assert.rejects(activateService('1h'), error => error.code === 'AUTH_REQUIRED');
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/activate`, { method: 'POST' });
    assert.equal(response.status, 403);
    const endpoint = JSON.parse(fs.readFileSync(path.join(server.stateDir, 'endpoint.json')));
    assert.equal(endpoint.adminToken, undefined);
    assert.throws(() => server.activate(MAX_ACTIVATION_MS + 1));
  }));

  await t.test('rejects browser origins on HTTP and WebSocket', async t => supervisor(t, async server => {
    server.activate();
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/status`, { headers: { Origin: 'https://example.com' } });
    assert.equal(response.status, 403);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/run`, { origin: 'https://example.com' });
    await assert.rejects(once(ws, 'open'), /403/);
  }));

  await t.test('pipes retain stdout, stderr and the real exit code', async t => supervisor(t, async server => {
    server.activate();
    const stdout = capture(), stderr = capture();
    const result = await runCommand({ argv: nodeCommand('console.log("HELLO"); console.error("ERROR"); process.exitCode=23;'), stdout, stderr });
    assert.equal(result.code, 23);
    assert.equal(stdout.text().trim(), 'HELLO');
    assert.equal(stderr.text().trim(), 'ERROR');
  }));

  await t.test('audit records lifecycle without arguments, output, environment or activation credentials', async t => supervisor(t, async (server, dir) => {
    server.activate();
    const secret = 'SUWIN_SECRET_SHOULD_NEVER_APPEAR_IN_AUDIT';
    await runCommand({ argv: nodeCommand(`console.log(${JSON.stringify(secret)})`), env: { SUWIN_TEST_SECRET: secret }, stdout: noop, stderr: noop });
    server.deactivate();
    const log = fs.readFileSync(path.join(dir, 'suwinsvc.log'), 'utf8');
    assert.match(log, /session_started/);
    assert.match(log, /session_exited/);
    assert.match(log, /deactivated/);
    assert.ok(!log.includes(secret));
    assert.ok(!log.includes(server.adminToken));
    assert.ok(!log.includes(server.stopToken));
  }));

  await t.test('direct executable arguments preserve spaces, quotes, punctuation and Unicode', async t => supervisor(t, async server => {
    server.activate();
    const args = ['', 'a b', 'quote"value', 'C:\\space dir\\', 'A&B|C<D>E^F!G', '%SUWIN_TEST_LITERAL%', 'ação中文'];
    const stdout = capture();
    await runCommand({ argv: [...nodeCommand('console.log(JSON.stringify(process.argv.slice(1)))'), ...args], stdout, stderr: noop });
    assert.deepEqual(JSON.parse(stdout.text()), args);
  }));

  await t.test('uses the caller environment and cwd while preserving Windows system paths', async t => supervisor(t, async (server, dir) => {
    server.activate();
    const cwd = path.join(dir, 'working directory');
    fs.mkdirSync(cwd);
    const stdout = capture();
    await runCommand({ argv: nodeCommand('console.log(JSON.stringify({cwd:process.cwd(),mark:process.env.SUWIN_TEST_MARK,root:process.env.SystemRoot}))'),
      cwd, env: { SUWIN_TEST_MARK: 'forwarded', SystemRoot: 'invalid-client-root' }, stdout, stderr: noop });
    const result = JSON.parse(stdout.text());
    assert.equal(result.cwd, cwd);
    assert.equal(result.mark, 'forwarded');
    if (windows) assert.equal(result.root, process.env.SystemRoot);
  }));

  await t.test('the child inherits the supervisor privilege level', { skip: !windows }, async t => supervisor(t, async server => {
    server.activate();
    const moduleUrl = new URL('../src/windows.js', import.meta.url).href;
    const stdout = capture();
    const result = await runCommand({ argv: [process.execPath, '--input-type=module', '-e', `import {isWindowsElevated} from ${JSON.stringify(moduleUrl)}; console.log(isWindowsElevated())`], stdout, stderr: noop });
    assert.equal(result.code, 0);
    assert.equal(stdout.text().trim(), String(server.elevated));
  }));

  await t.test('batch shims resolve from caller PATH and preserve arguments', { skip: !windows }, async t => supervisor(t, async (server, dir) => {
    server.activate();
    const bin = path.join(dir, 'custom bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'print.cjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
    fs.writeFileSync(path.join(bin, 'example.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0print.cjs" %*\r\n`);
    const args = ['', 'a b', 'quoted"value', 'C:\\space dir\\', 'A&B|C<D>E^F!G', '%SUWIN_TEST_LITERAL%'];
    const stdout = capture(), stderr = capture();
    const result = await runCommand({ argv: ['example', ...args], env: { PATH: bin, PATHEXT: '.EXE;.CMD', SUWIN_TEST_LITERAL: 'must-not-expand' }, stdout, stderr });
    assert.equal(result.code, 0, stderr.text());
    assert.deepEqual(JSON.parse(stdout.text()), args);
  }));

  await t.test('shell commands and Windows builtins execute', async t => supervisor(t, async server => {
    server.activate();
    const stdout = capture();
    const result = await runCommand({ argv: ['echo SHELL_OK'], shell: true, stdout, stderr: noop });
    assert.equal(result.code, 0);
    assert.match(stdout.text(), /SHELL_OK/);
    if (windows) {
      const builtin = capture();
      assert.equal((await runCommand({ argv: ['echo', 'BUILTIN_OK'], stdout: builtin, stderr: noop })).code, 0);
      assert.match(builtin.text(), /BUILTIN_OK/);
    }
  }));

  await t.test('failed executables are errors, never a successful exit', async t => supervisor(t, async server => {
    server.activate();
    await assert.rejects(runCommand({ argv: ['suwin-does-not-exist-12345'] }));
    assert.equal(server.sessions.size, 0);
  }));

  await t.test('large stdin is ordered, flow-controlled and followed by EOF', async t => supervisor(t, async server => {
    server.activate();
    const payload = Buffer.alloc(6 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const expected = crypto.createHash('sha256').update(payload).digest('hex');
    const stdout = capture();
    const result = await runCommand({ argv: nodeCommand('let n=0;const h=require("node:crypto").createHash("sha256");process.stdin.on("data",d=>{n+=d.length;h.update(d)});process.stdin.on("end",()=>console.log(JSON.stringify({n,hash:h.digest("hex")})))'),
      stdin: Readable.from([payload]), stdout, stderr: noop, timeoutMs: 15000 });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(stdout.text()), { n: payload.length, hash: expected });
  }));

  await t.test('slow output consumers receive all data without truncation', async t => supervisor(t, async server => {
    server.activate();
    const size = 4 * 1024 * 1024;
    let received = 0;
    const stdout = new Writable({ highWaterMark: 1024, write(chunk, encoding, callback) {
      received += chunk.length;
      assert.ok(chunk.every(byte => byte === 97));
      setTimeout(callback, 1);
    } });
    const result = await runCommand({ argv: nodeCommand(`process.stdout.write(Buffer.alloc(${size},97));process.exitCode=27`), stdout, stderr: noop, timeoutMs: 15000 });
    await new Promise(resolve => stdout.end(resolve));
    assert.equal(result.code, 27);
    assert.equal(received, size);
  }));

  await t.test('concurrent commands remain independent', async t => supervisor(t, async server => {
    server.activate();
    await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const stdout = capture();
      const result = await runCommand({ argv: nodeCommand(`setTimeout(()=>{console.log(${index});process.exitCode=${index}},${(8 - index) * 20})`), stdout, stderr: noop });
      assert.equal(result.code, index);
      assert.equal(stdout.text().trim(), String(index));
    }));
    assert.equal(server.sessions.size, 0);
  }));

  await t.test('stalled stdin cannot exhaust workers needed by other terminal sessions', { skip: !windows }, async () => {
    const stalled = Array.from({ length: 8 }, () => new Session({ argv: nodeCommand('setInterval(()=>{},1000)'), timeoutMs: 5000 }));
    try {
      for (const session of stalled) {
        session.start();
        session.writeStdin(Buffer.alloc(256 * 1024));
      }
      const terminal = new Session({ argv: nodeCommand('console.log("INDEPENDENT")'), tty: true, cols: 80, rows: 24, timeoutMs: 1500 });
      terminal.start();
      assert.equal((await terminal.done).code, 0);
    } finally {
      for (const session of stalled) session.terminate();
      await Promise.all(stalled.map(session => session.done));
    }
  });

  await t.test('failed native process creation cleans up a partially created terminal', { skip: !windows }, async t => supervisor(t, async (server, dir) => {
    server.activate();
    const invalidExe = path.join(dir, 'invalid.exe');
    fs.writeFileSync(invalidExe, 'This is not a Windows executable');
    await assert.rejects(runCommand({ argv: [invalidExe], tty: true }), error => error.code === 'spawn_failed');
    const result = await runCommand({ argv: nodeCommand('process.exit(0)'), tty: true, stdout: noop, stderr: noop });
    assert.equal(result.code, 0);
  }));

  await t.test('native TTY dimensions and resize reach the target', { skip: !windows }, async () => {
    let output = '', resized = false;
    const session = new Session({ argv: nodeCommand('process.stdout.on("resize",()=>{console.log(JSON.stringify([process.stdout.columns,process.stdout.rows]));process.exit(0)});process.stdin.setRawMode(true);process.stdin.resume();console.log(JSON.stringify([process.stdout.isTTY,process.stdout.columns,process.stdout.rows]));setInterval(()=>{},1000)'),
      tty: true, cols: 100, rows: 35, timeoutMs: 7000 }, { onStdout(data) {
        output += data.toString();
        if (!resized && output.includes('[true,100,35]')) { resized = true; session.resize(144, 44); }
      } });
    assert.equal(session.start().mode, 'pty');
    const result = await session.done;
    assert.equal(result.code, 0, output);
    assert.match(output, /\[144,44\]/);
  });

  await t.test('a handled terminal Ctrl+C preserves the application exit code', { skip: !windows }, async t => supervisor(t, async server => {
    server.activate();
    const stdin = new PassThrough();
    stdin.isTTY = true;
    let output = '', interrupted = false;
    const stdout = { write(data) {
      output += data.toString();
      if (!interrupted && output.includes('READY')) { interrupted = true; stdin.write(Buffer.from([3])); }
      return true;
    } };
    const result = await runCommand({ argv: nodeCommand('process.on("SIGINT",()=>{console.log("HANDLED");process.exit(0)});console.log("READY");setInterval(()=>{},1000)'),
      tty: true, stdin, stdout, stderr: noop, timeoutMs: 7000 });
    assert.equal(result.code, 0);
    assert.equal(result.reason, 'exited');
    assert.match(output, /HANDLED/);
    assert.equal(stdin.listenerCount('data'), 0);
  }));

  await t.test('raw terminal Ctrl+C preserves every byte and leaves the TUI alive past three seconds', { skip: !windows }, async t => supervisor(t, async server => {
    server.activate();
    const stdin = new PassThrough();
    stdin.isTTY = true;
    const stdout = capture();
    let pid, exited = false;
    const command = runCommand({ argv: nodeCommand(interactiveTree()), tty: true, stdin, stdout, stderr: noop, timeoutMs: 12000,
      onStarted: info => { pid = info.pid; } });
    const outcome = command.then(result => { exited = true; return result; }, error => { exited = true; throw error; });
    outcome.catch(() => {});
    await waitFor(() => /CHILD:\d+/.test(stdout.text()));
    const descendant = Number(/CHILD:(\d+)/.exec(stdout.text())[1]);
    stdin.write(Buffer.from([97, 3, 98, 3, 99, 3]));
    await waitFor(() => stdout.text().includes('INPUT:[97,3,98,3,99,3]'));
    await delay(3300);
    assert.equal(exited, false, stdout.text());
    assert.ok(alive(pid) && alive(descendant));
    stdin.write('q');
    const result = await outcome;
    assert.equal(result.code, 37);
    assert.equal(result.reason, 'exited');
    assert.match(stdout.text(), /BYTES:\[97,3,98,3,99,3\]/);
    await waitFor(() => !alive(pid) && !alive(descendant));
    assert.equal(server.sessions.size, 0);
    assert.equal(stdin.listenerCount('data'), 0);
    assert.equal(stdin.readableFlowing, false);
  }));

  await t.test('explicit terminal interrupt messages remain repeatable and never escalate on a timer', { skip: !windows }, async t => supervisor(t, async server => {
    server.activate();
    const ws = await raw(server);
    let output = '', result = null;
    ws.on('message', (data, binary) => {
      if (binary && data[0] === 0) output += data.subarray(1).toString();
      else if (!binary) { const message = JSON.parse(data); if (message.type === 'exit') result = message; }
    });
    try {
      const started = await frame(ws, { ...startRequest(interactiveTree()), tty: true, cols: 100, rows: 35 });
      await waitFor(() => /CHILD:\d+/.test(output));
      const descendant = Number(/CHILD:(\d+)/.exec(output)[1]);
      ws.send(JSON.stringify({ type: 'interrupt' }));
      ws.send(JSON.stringify({ type: 'interrupt' }));
      await waitFor(() => output.includes('INPUT:[3,3]'));
      await delay(3300);
      assert.equal(result, null, output);
      assert.ok(alive(started.pid) && alive(descendant));
      ws.send(Buffer.from([2, 113]));
      await waitFor(() => result !== null);
      assert.equal(result.code, 37);
      assert.equal(result.reason, 'exited');
      await waitFor(() => !alive(started.pid) && !alive(descendant));
    } finally { ws.terminate(); }
  }));

  for (const action of ['abort', 'deactivate', 'timeout', 'expiry']) {
    await t.test(`${action} after terminal Ctrl+C still kills the complete process tree`, { skip: !windows }, async t => supervisor(t, async server => {
      server.activate(action === 'expiry' ? 1500 : 60000);
      const controller = new AbortController(), stdin = new PassThrough(), stdout = capture();
      stdin.isTTY = true;
      let pid;
      const command = runCommand({ argv: nodeCommand(interactiveTree()), tty: true, stdin, stdout, stderr: noop,
        signal: controller.signal, timeoutMs: action === 'timeout' ? 1500 : 10000, onStarted: info => { pid = info.pid; } });
      const outcome = command.catch(error => error);
      await waitFor(() => /CHILD:\d+/.test(stdout.text()));
      const descendant = Number(/CHILD:(\d+)/.exec(stdout.text())[1]);
      stdin.write(Buffer.from([3]));
      await waitFor(() => stdout.text().includes('INPUT:[3]'));
      assert.ok(alive(pid) && alive(descendant));
      if (action === 'abort') controller.abort();
      if (action === 'deactivate') server.deactivate();
      const result = await outcome;
      if (action === 'abort') assert.equal(result.code, 'ABORTED');
      else {
        assert.equal(result.code, action === 'timeout' ? 124 : 143);
        assert.equal(result.reason, { deactivate: 'deactivated', timeout: 'timeout', expiry: 'expired' }[action]);
      }
      await waitFor(() => !alive(pid) && !alive(descendant) && server.sessions.size === 0);
      assert.equal(stdin.listenerCount('data'), 0);
    }));
  }

  await t.test('killing an actual terminal client after Ctrl+C leaves no descendants', { skip: !windows }, async t => supervisor(t, async server => {
    server.activate();
    const client = spawn(process.execPath, [path.join(project, 'bin', 'suwin.js'), '-t', ...nodeCommand(interactiveTree())], { windowsHide: true });
    const stdout = capture(), stderr = capture();
    client.stdout.on('data', data => stdout.write(data));
    client.stderr.on('data', data => stderr.write(data));
    try {
      await waitFor(() => /CHILD:\d+/.test(stdout.text()));
      const descendant = Number(/CHILD:(\d+)/.exec(stdout.text())[1]);
      const pid = [...server.sessions.values()][0].pid;
      client.stdin.write(Buffer.from([3]));
      await waitFor(() => stdout.text().includes('INPUT:[3]'));
      const exited = once(client, 'exit');
      client.kill();
      await exited;
      await waitFor(() => !alive(pid) && !alive(descendant) && server.sessions.size === 0);
      assert.equal(stderr.text(), '');
    } finally {
      if (client.exitCode === null && client.signalCode === null) { const exited = once(client, 'exit'); client.kill(); await exited; }
    }
  }));

  await t.test('the CLI forwards repeated Ctrl+C from an actual raw terminal', { skip: !windows }, async t => supervisor(t, async server => {
    server.activate();
    let output = '';
    const terminal = new Session({ argv: [process.execPath, path.join(project, 'bin', 'suwin.js'), '-t', ...nodeCommand(interactiveTree())],
      tty: true, cols: 120, rows: 40, timeoutMs: 12000 }, { onStdout: data => { output += data.toString(); } });
    const clientPid = terminal.start().pid;
    try {
      await waitFor(() => /CHILD:\d+/.test(output));
      const descendant = Number(/CHILD:(\d+)/.exec(output)[1]);
      const pid = [...server.sessions.values()][0].pid;
      terminal.writeStdin(Buffer.from([97, 3, 98, 3, 99, 3]));
      await waitFor(() => output.includes('INPUT:[97,3,98,3,99,3]'));
      terminal.writeStdin(Buffer.from('q'));
      const result = await terminal.done;
      assert.equal(result.code, 37, output);
      await waitFor(() => !alive(clientPid) && !alive(pid) && !alive(descendant) && server.sessions.size === 0);
    } finally {
      terminal.terminate();
      await terminal.done;
    }
  }));

  await t.test('timeouts kill a command and its descendants', async t => supervisor(t, async server => {
    server.activate();
    const stdout = capture();
    let pid;
    const result = await runCommand({ argv: nodeCommand(childTree()), timeoutMs: 700, stdout, stderr: noop, onStarted: info => { pid = info.pid; } });
    assert.equal(result.code, 124);
    assert.equal(result.reason, 'timeout');
    const descendant = Number(/CHILD:(\d+)/.exec(stdout.text())?.[1]);
    assert.ok(descendant, stdout.text());
    await waitFor(() => !alive(pid) && !alive(descendant));
  }));

  await t.test('interrupting a pipe command still terminates its complete process tree', async t => supervisor(t, async server => {
    server.activate();
    const ws = await raw(server);
    let output = '', result = null;
    ws.on('message', (data, binary) => {
      if (binary && data[0] === 0) output += data.subarray(1).toString();
      else if (!binary) { const message = JSON.parse(data); if (message.type === 'exit') result = message; }
    });
    try {
      const started = await frame(ws, startRequest(childTree()));
      await waitFor(() => /CHILD:\d+/.test(output));
      const descendant = Number(/CHILD:(\d+)/.exec(output)[1]);
      ws.send(JSON.stringify({ type: 'interrupt' }));
      await waitFor(() => result !== null);
      assert.equal(result.code, 130);
      assert.equal(result.reason, 'interrupted');
      await waitFor(() => !alive(started.pid) && !alive(descendant) && server.sessions.size === 0);
    } finally { ws.terminate(); }
  }));

  await t.test('authorization expiry kills existing commands', async t => supervisor(t, async server => {
    server.activate(600);
    let pid;
    const result = await runCommand({ argv: nodeCommand('setInterval(()=>{},1000)'), stdout: noop, stderr: noop, onStarted: info => { pid = info.pid; } });
    assert.equal(result.reason, 'expired');
    assert.equal(result.code, 143);
    assert.equal(server.isActive(), false);
    await waitFor(() => !alive(pid));
  }));

  await t.test('deactivation closes pending authorization windows before process creation', async t => supervisor(t, async server => {
    server.activate();
    const ws = await raw(server);
    server.deactivate();
    server.activate();
    const result = await frame(ws, startRequest('console.log("must not run")'));
    assert.equal(result.code, 'service_inactive');
    assert.equal(server.sessions.size, 0);
    ws.terminate();
  }));

  await t.test('pending sockets count toward the concurrency limit', async t => supervisor(t, async server => {
    server.activate();
    const ws = await raw(server);
    const rejected = new WebSocket(`ws://127.0.0.1:${server.port}/v1/run`);
    await assert.rejects(once(rejected, 'open'), /429/);
    ws.terminate();
  }, { maxSessions: 1 }));

  await t.test('start requests validate schema and fields before spawning', async t => supervisor(t, async server => {
    server.activate();
    for (const override of [{ schema: 999 }, { argv: [] }, { argv: [123] }, { env: [] }, { timeoutMs: -1 }, { cols: 0 }, { tty: 'yes' }]) {
      const ws = await raw(server);
      const result = await frame(ws, { ...startRequest('process.exit(0)'), ...override });
      assert.equal(result.code, 'bad_request');
      ws.terminate();
    }
    assert.equal(server.sessions.size, 0);
  }));

  await t.test('a socket that never sends start is timed out', async t => supervisor(t, async server => {
    server.activate();
    const ws = await raw(server);
    const [data] = await once(ws, 'message');
    assert.equal(JSON.parse(data).code, 'bad_request');
    ws.terminate();
  }, { startRequestTimeoutMs: 100 }));

  await t.test('a client that stops responding to pings loses its process tree', async t => supervisor(t, async server => {
    server.activate();
    const ws = await raw(server, { autoPong: false });
    const started = await frame(ws, startRequest('setInterval(()=>{},1000)'));
    assert.equal(started.type, 'started');
    await once(ws, 'close');
    await waitFor(() => !alive(started.pid) && server.sessions.size === 0);
  }, { keepAliveIntervalMs: 100 }));

  await t.test('the client detects a silent supervisor instead of waiting forever', async t => temporary(t, async dir => {
    const httpServer = http.createServer();
    const sockets = new WebSocketServer({ server: httpServer, autoPong: false });
    sockets.on('connection', ws => ws.once('message', () => ws.send(JSON.stringify({ type: 'started', mode: 'pipe', pid: process.pid }))));
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    writeEndpoint(dir, { port: httpServer.address().port, instance: 'silent-test-supervisor' });
    try {
      await assert.rejects(runCommand({ argv: nodeCommand('process.exit(0)'), keepAliveIntervalMs: 50 }), error => error.code === 'UNREACHABLE');
    } finally {
      for (const ws of sockets.clients) ws.terminate();
      await new Promise(resolve => sockets.close(resolve));
      await new Promise(resolve => httpServer.close(resolve));
    }
  }));

  await t.test('client abort kills descendants and removes input listeners', async t => supervisor(t, async server => {
    server.activate();
    const controller = new AbortController(), stdout = capture(), stdin = new PassThrough();
    let pid;
    const promise = runCommand({ argv: nodeCommand(childTree()), signal: controller.signal, stdin, stdout, stderr: noop, onStarted: info => { pid = info.pid; } });
    const outcome = promise.catch(error => error);
    await waitFor(() => /CHILD:\d+/.test(stdout.text()));
    const descendant = Number(/CHILD:(\d+)/.exec(stdout.text())[1]);
    controller.abort();
    assert.equal((await outcome).code, 'ABORTED');
    await waitFor(() => !alive(pid) && !alive(descendant));
    assert.equal(stdin.listenerCount('data'), 0);
    assert.equal(stdin.listenerCount('end'), 0);
  }));

  await t.test('a second supervisor cannot overwrite a live endpoint', async t => supervisor(t, async (server, dir) => {
    const before = fs.readFileSync(path.join(dir, 'endpoint.json'), 'utf8');
    const second = new SuwinServer({ tray: false });
    await assert.rejects(second.start(), /already running/);
    await second.stop();
    assert.equal(fs.readFileSync(path.join(dir, 'endpoint.json'), 'utf8'), before);
    assert.equal((await getStatus()).instance, server.instanceId);
  }));

  for (const tty of [false, true]) {
    await t.test(`killing the supervisor closes its Job Objects and ${tty ? 'interrupted TUI' : 'pipe'} descendants`, { skip: !windows }, async t => temporary(t, async () => {
    const daemon = spawn(process.execPath, [path.join(project, 'test', 'fixtures', 'daemon.js')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let errors = '';
    daemon.stderr.on('data', data => { errors += data; });
    try {
      await once(daemon, 'message', { signal: AbortSignal.timeout(5000) });
      const stdout = capture(), stdin = new PassThrough();
      stdin.isTTY = tty;
      let pid;
      const promise = runCommand({ argv: nodeCommand(tty ? interactiveTree() : childTree()), tty, stdin, stdout, stderr: noop, onStarted: info => { pid = info.pid; } });
      const outcome = promise.catch(error => error);
      await waitFor(() => /CHILD:\d+/.test(stdout.text()));
      const descendant = Number(/CHILD:(\d+)/.exec(stdout.text())[1]);
      if (tty) {
        stdin.write(Buffer.from([3]));
        await waitFor(() => stdout.text().includes('INPUT:[3]'));
      }
      const exited = once(daemon, 'exit');
      daemon.kill();
      await exited;
      assert.equal((await outcome).code, 'DISCONNECTED');
      await waitFor(() => !alive(pid) && !alive(descendant));
      const replacement = new SuwinServer({ tray: false });
      await replacement.start();
      assert.equal((await getStatus()).instance, replacement.instanceId);
      await replacement.stop();
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill(); await exited; }
      assert.equal(errors, '');
    }
    }));
  }

  await t.test('background launcher preserves options and safely quotes Windows paths', { skip: !windows }, () => {
    const args = serviceArguments("C:\\User's folder\\suwinsvc.js", { active: true, activeDuration: 900000, port: 51234, tray: false });
    assert.deepEqual(args.slice(1), ['--daemon', '--active', '900000ms', '--port', '51234', '--no-tray']);
    const foreground = serviceArguments('suwinsvc.js', { foreground: true, tray: true });
    assert.deepEqual(foreground, ['suwinsvc.js', '--foreground']);
    assert.match(elevationScript(process.execPath, foreground, { foreground: true }), /-Verb RunAs -WindowStyle Normal/);
    const script = elevationScript("C:\\Program Files\\Node's runtime\\node.exe", args);
    assert.match(script, /-Verb RunAs -WindowStyle Hidden/);
    const parsed = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$errors=$null; [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$null,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }'], { input: script, encoding: 'utf8', windowsHide: true });
    assert.equal(parsed.status, 0, parsed.stderr);
  });

  await t.test('CLI waits for output and preserves the exit code', async t => supervisor(t, async server => {
    server.activate();
    const child = spawn(process.execPath, [path.join(project, 'bin', 'suwin.js'), '--no-tty', ...nodeCommand('console.log("CLI_OK");process.exitCode=19')], { windowsHide: true });
    const stdout = capture(), stderr = capture();
    child.stdout.on('data', data => stdout.write(data));
    child.stderr.on('data', data => stderr.write(data));
    child.stdin.end();
    const [code] = await once(child, 'exit');
    assert.equal(code, 19, stderr.text());
    assert.equal(stdout.text().trim(), 'CLI_OK');
  }));
});
