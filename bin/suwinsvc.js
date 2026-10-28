#!/usr/bin/env node
// bin/suwinsvc.js - The Security Undertaking Windows daemon with Tray Icon and background detachment
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { SuwinServer } from '../src/server.js';
import { getStatus } from '../src/client.js';
import * as state from '../src/state.js';
const { isElevated, getCurrentUser, removeEndpoint } = state;
import { parseDuration, formatDuration } from '../src/protocol.js';

const __filename = fileURLToPath(import.meta.url);

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
  const options = {
    daemon: false,
    foreground: false,
    active: false,
    activeDuration: 15 * 60 * 1000,
    port: 0,
    tray: true,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--daemon') {
      options.daemon = true;
    } else if (arg === '-f' || arg === '--foreground') {
      options.foreground = true;
    } else if (arg === '--no-tray') {
      options.tray = false;
    } else if (arg === '-p' || arg === '--port') {
      options.port = parseInt(args[++i], 10) || 0;
    } else if (arg === '-a' || arg === '--active' || arg === '--activate') {
      options.active = true;
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        options.activeDuration = parseDuration(next, options.activeDuration);
        i++;
      }
    }
  }

  const autoAct = process.env.SUWIN_AUTOACTIVATE;
  if (autoAct) {
    options.active = true;
    options.activeDuration = parseDuration(autoAct, options.activeDuration);
  }

  return options;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(usage);
    process.exit(0);
  }

  // 1. Check if another instance is already running
  try {
    const existing = await getStatus();
    if (existing) {
      console.log(`[suwinsvc] suwin supervisor service is already running on port ${existing.port} (PID ${existing.pid}).`);
      console.log(`[suwinsvc] Session: ${existing.active ? 'ACTIVE' : 'INACTIVE'}`);
      console.log(`[suwinsvc] Look for the icon in your system tray (or check the ^ arrow menu).`);
      process.exit(0);
    }
  } catch {
    // If endpoint.json exists but is dead / unreachable, clean it up!
    state.removeEndpoint();
  }

  const elevated = isElevated();

  // If invoked normally in terminal (not --daemon and not --foreground), detach and free terminal!
  if (!opts.daemon && !opts.foreground) {
    if (!elevated) {
      console.log('[suwinsvc] Requesting administrative privileges to start supervisor service...');
      const argsList = `"${__filename}" --daemon ${opts.active ? `--active ${opts.activeDuration}ms` : ''} ${!opts.tray ? '--no-tray' : ''}`;
      const psCommand = `Start-Process node -ArgumentList '${argsList}' -Verb RunAs -WindowStyle Hidden`;
      
      try {
        spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psCommand], {
          detached: true,
          stdio: 'ignore'
        }).unref();

        console.log('[suwinsvc] ✓ Supervisor service launched in background!');
        console.log('[suwinsvc] ✓ Terminal released.');
        console.log('[suwinsvc] ✓ System tray monitor active in Windows notification area.');
        process.exit(0);
      } catch (err) {
        console.error(`[suwinsvc] Failed to launch: ${err.message}`);
        process.exit(1);
      }
    } else {
      // Already elevated, just detach background process
      const childArgs = [__filename, '--daemon'];
      if (opts.active) childArgs.push('--active', `${opts.activeDuration}ms`);
      if (!opts.tray) childArgs.push('--no-tray');

      try {
        const bg = spawn(process.execPath, childArgs, {
          detached: true,
          stdio: 'ignore'
        });
        bg.unref();

        console.log('[suwinsvc] ✓ Service started in background!');
        console.log('[suwinsvc] ✓ Terminal released.');
        console.log('[suwinsvc] ✓ Look for the shield icon in your Windows notification area.');
        process.exit(0);
      } catch (err) {
        console.error(`[suwinsvc] Failed to detach: ${err.message}`);
        process.exit(1);
      }
    }
    return;
  }

  // Running as Daemon or Foreground
  const server = new SuwinServer({
    tray: opts.tray,
    onStateChange: () => {
      if (opts.foreground) {
        renderStatus();
      }
    }
  });

  let runningInfo = null;

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
    if (st.active) {
      console.log(`  Session State:    🟢 ACTIVE (${formatDuration(st.secondsLeft * 1000)} remaining)`);
    } else {
      console.log(`  Session State:    ⚪ INACTIVE`);
    }
    console.log(`  Active Sessions:  ${st.sessions} / ${st.maxSessions}`);
    console.log('===============================================================');
  }

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    await server.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    runningInfo = await server.start(opts.port);

    if (opts.active) {
      server.activate(opts.activeDuration);
    }

    if (opts.foreground) {
      renderStatus();
      setInterval(() => {
        if (server.active) renderStatus();
      }, 1000);
    }
  } catch (err) {
    console.error(`[suwinsvc] Failed to start: ${err.message}`);
    process.exit(1);
  }
}

main();
