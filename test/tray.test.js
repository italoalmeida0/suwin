import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { TrayIcon } from '../src/tray.js';
import http from 'node:http';
import koffi from 'koffi';
import { setTimeout as delay } from 'node:timers/promises';

test('a blocked tray worker leaves the supervisor event loop responsive', async () => {
  const server = { stateDir: '', getStatus: () => ({ active: false }), audit() {}, stop() {} };
  const tray = new TrayIcon(server, { workerUrl: new URL('./fixtures/tray-block.js', import.meta.url) });
  await tray.start();
  try {
    let blocked = false;
    tray.worker.on('message', message => { if (message.type === 'blocked') blocked = true; if (message.type === 'unblocked') blocked = false; });
    const message = once(tray.worker, 'message');
    tray.update();
    await message;
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(blocked, true, 'A main-thread timer must fire while the UI worker is blocked');
  } finally { await tray.destroy(); }
});

test('native notification icon starts and releases its worker', { skip: process.env.SUWIN_TRAY_TEST !== '1' }, async () => {
  const server = { stateDir: process.cwd(), getStatus: () => ({ active: false, port: 0, sessions: 0, secondsLeft: 0 }), audit() {}, stop() {} };
  const tray = new TrayIcon(server);
  await tray.start();
  assert.ok(tray.hwnd);
  await tray.destroy();
  assert.equal(tray.worker, null);
});

test('an actual open Win32 tray menu cannot block HTTP or shutdown', { skip: process.env.SUWIN_TRAY_TEST !== '1', timeout: 10000 }, async () => {
  const httpServer = http.createServer((req, res) => res.end('responsive'));
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const server = { stateDir: process.cwd(), getStatus: () => ({ active: false, port: httpServer.address().port, sessions: 0, secondsLeft: 0 }), audit() {}, stop() {} };
  const tray = new TrayIcon(server);
  try {
    await tray.start();
    const user = koffi.load('user32.dll');
    const thread = user.func('uint32 __stdcall GetWindowThreadProcessId(void*, _Out_ uint32*)')(tray.hwnd, [0]);
    const getInfo = user.func('int __stdcall GetGUIThreadInfo(uint32, void*)');
    const info = Buffer.alloc(8 + 6 * koffi.sizeof('void*') + 16);
    const inMenu = () => { info.writeUInt32LE(info.length); return Boolean(getInfo(thread, info) && (info.readUInt32LE(4) & 4)); };
    // Drive only this test's own notification window; no desktop coordinates,
    // synthetic keyboard input, or authorization-menu selection is involved.
    user.func('int __stdcall PostMessageW(void*, uint32, uintptr_t, intptr_t)')(tray.hwnd, 0x400 + 100, 0, 0x205);
    const deadline = Date.now() + 3000;
    while (!inMenu() && Date.now() < deadline) await delay(20);
    assert.equal(inMenu(), true, 'The native menu must actually be open');
    const response = await fetch(`http://127.0.0.1:${httpServer.address().port}`, { signal: AbortSignal.timeout(1000) });
    assert.equal(await response.text(), 'responsive');
    assert.equal(inMenu(), true);
  } finally {
    await tray.destroy();
    await new Promise(resolve => { httpServer.close(resolve); httpServer.closeIdleConnections?.(); });
  }
});
