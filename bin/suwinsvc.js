#!/usr/bin/env node
// bin/suwinsvc.js - The Security Undertaking Windows daemon with Tray Icon and background detachment
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SuwinServer } from '../src/server.js';
import { getStatus } from '../src/client.js';
import { launchService } from '../src/launch.js';
import { isElevated } from '../src/state.js';
import { parseDuration, formatDuration, MAX_ACTIVATION_MS } from '../src/protocol.js';

const filename = fileURLToPath(import.meta.url);
const usage = `suwinsvc - Security Undertaking Windows daemon service (Node.js)

Usage:
  suwinsvc [options]

Options:
  -f, --foreground      run in foreground terminal monitor instead of background
  -a, --active [dur]    start with authorized session window active (default: 15m)
  -p, --port <port>     port to bind (default: random free loopback port)
  --no-tray             disable the system tray icon
  -h, --help            show this help

By default, running 'suwinsvc' starts the supervisor service in the background,
shows a tray icon in the Windows notification area, and immediately frees your terminal.
`;

function parseArgs(args) {
  const options = { daemon: false, foreground: false, active: false, activeDuration: 15 * 60 * 1000, port: 0, tray: true, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') { options.help = true; return options; }
    if (arg === '--daemon') options.daemon = true;
    else if (arg === '-f' || arg === '--foreground') options.foreground = true;
    else if (arg === '--no-tray') options.tray = false;
    else if (arg === '-p' || arg === '--port') {
      const value = args[++i];
      if (!value || !/^\d+$/.test(value) || Number(value) > 65535) throw new Error('--port requires an integer between 0 and 65535');
      options.port = Number(value);
    } else if (arg === '-a' || arg === '--active' || arg === '--activate') {
      options.active = true;
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        options.activeDuration = parseDuration(args[++i], 0);
        if (!options.activeDuration || options.activeDuration > MAX_ACTIVATION_MS) throw new Error('--active requires a duration of at most 24 hours');
      }
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (process.env.SUWIN_AUTOACTIVATE) {
    options.active = true;
    options.activeDuration = parseDuration(process.env.SUWIN_AUTOACTIVATE, 0);
    if (!options.activeDuration || options.activeDuration > MAX_ACTIVATION_MS) throw new Error('SUWIN_AUTOACTIVATE requires a duration of at most 24 hours');
  }
  return options;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`[suwinsvc] ${error.message}`); process.exitCode = 2; return; }
  if (opts.help) { console.log(usage); return; }
  try {
    const status = await getStatus();
    console.log(`[suwinsvc] suwin supervisor service is already running on port ${status.port} (PID ${status.pid}).`);
    console.log(`[suwinsvc] Session: ${status.active ? 'ACTIVE' : 'INACTIVE'}`);
    return;
  } catch {}

  const elevated = isElevated();
  if (!opts.daemon && (!opts.foreground || !elevated)) {
    if (!elevated) console.log('[suwinsvc] Requesting administrative privileges to start supervisor service...');
    try {
      await launchService(filename, opts, elevated);
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try {
          const status = await getStatus({ timeoutMs: 500 });
          console.log(`[suwinsvc] Service ready on port ${status.port} (PID ${status.pid}, ${status.elevated ? 'elevated' : 'restricted'}).`);
          if (opts.tray) console.log('[suwinsvc] Look for the shield icon in your Windows notification area.');
          return;
        } catch { await delay(100); }
      }
      throw new Error('The supervisor did not report ready within 15 seconds');
    } catch (error) {
      console.error(`[suwinsvc] Failed to launch: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  let runningInfo = null, refreshTimer = null;
  const server = new SuwinServer({ tray: opts.tray,
    onStateChange: () => { if (opts.foreground && !stopping) renderStatus(); },
    onStopped: () => { if (server.auditFailed) process.exitCode = 1; clearInterval(refreshTimer); process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); } });
  function renderStatus() {
    const st = server.getStatus();
    console.clear();
    console.log('===============================================================');
    console.log('  Security Undertaking Windows (suwin) - Session Supervisor');
    console.log('===============================================================');
    console.log(`  Privilege Level:  ${st.elevated ? '✓ ELEVATED (Full System Control)' : '✗ RESTRICTED'}`);
    console.log(`  Current User:     ${st.currentUser}`);
    console.log(`  Port:             ${runningInfo?.port || 'starting...'} (state: ${runningInfo?.dir || ''})`);
    console.log(`  Process ID (PID): ${st.pid}`);
    console.log('---------------------------------------------------------------');
    console.log(`  Session State:    ${st.active ? `🟢 ACTIVE (${formatDuration(st.secondsLeft * 1000)} remaining)` : '⚪ INACTIVE'}`);
    console.log(`  Active Sessions:  ${st.sessions} / ${st.maxSessions}`);
    console.log('===============================================================');
  }
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(refreshTimer);
    try { await server.stop(); }
    catch (error) { console.error(`[suwinsvc] ${error.message}`); process.exitCode = 1; }
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    runningInfo = await server.start(opts.port);
    if (opts.active) server.activate(opts.activeDuration);
    if (opts.foreground) {
      renderStatus();
      refreshTimer = setInterval(() => renderStatus(), 1000);
    }
  } catch (error) {
    console.error(`[suwinsvc] Failed to start: ${error.message}`);
    process.exitCode = 1;
    await shutdown();
  }
}

main().catch(error => { console.error(`[suwinsvc] ${error.message}`); process.exitCode = 1; });
