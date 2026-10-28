#!/usr/bin/env node
// bin/suwin.js - Security Undertaking Windows client CLI
import { runCommand, getStatus, SuwinClientError } from '../src/client.js';
import { parseDuration } from '../src/protocol.js';
import { VERSION } from '../src/version.js';

const usage = `suwin - Security Undertaking Windows execution client

Usage:
  suwin [options] <command> [args...]
  suwin [options] --shell "<command line>"

Options:
  -t, --tty             force pseudo-terminal allocation
      --no-tty          disable pseudo-terminal, stream standard I/O pipes
      --shell           execute command line through cmd.exe
      --timeout <dur>   terminate command execution after duration (e.g. 30s, 5m)
      --cwd <dir>       working directory for execution (default: current)
      --version         print client version and exit
  -h, --help            show this help

Examples:
  suwin whoami /priv
  suwin powershell -NoLogo
  suwin --shell "net stop wuauserv"
`;

function parseArgs(args) {
  const opts = {
    argv: [],
    shell: false,
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    timeoutMs: 0,
    cwd: process.cwd(),
    version: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { opts.argv = args.slice(i + 1); break; }
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      return opts;
    }
    if (arg === '--version') {
      opts.version = true;
      return opts;
    }
    if (arg === '-t' || arg === '--tty') {
      opts.tty = true;
      continue;
    }
    if (arg === '--no-tty') {
      opts.tty = false;
      continue;
    }
    if (arg === '--shell') {
      opts.shell = true;
      continue;
    }
    if (arg === '--cwd') {
      if (!args[i + 1]) throw new Error('--cwd requires a directory');
      opts.cwd = args[++i];
      continue;
    }
    if (arg === '--timeout') {
      opts.timeoutMs = parseDuration(args[++i], 0);
      if (!opts.timeoutMs) throw new Error('--timeout requires a valid positive duration');
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    // First non-flag argument starts the command argv
    opts.argv = args.slice(i);
    break;
  }

  return opts;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`suwin: ${error.message}`); process.exitCode = 2; return; }

  if (opts.help) {
    console.log(usage);
    process.exit(0);
  }

  if (opts.version) {
    console.log(`suwin ${VERSION} (Security Undertaking Windows)`);
    process.exit(0);
  }

  if (opts.argv.length === 0) {
    console.error(usage);
    process.exit(2);
  }

  // Pre-flight check: ensure supervisor service is running and session is active
  try {
    const st = await getStatus();
    if (!st.active) {
      console.error('suwin: the supervisor session is currently INACTIVE.');
      console.error('To authorize execution, right-click the suwin tray icon in the notification area and click "Activate".');
      process.exit(1);
    }
  } catch (err) {
    console.error(`suwin: ${err.message}`);
    process.exit(1);
  }

  const wasRaw = Boolean(process.stdin.isRaw);
  let changedRaw = false;

  const cleanupTerminal = () => {
    if (changedRaw) {
      try {
        process.stdin.setRawMode(wasRaw);
      } catch {}
    }
  };

  try {
    const result = await runCommand({
      argv: opts.argv,
      shell: opts.shell,
      cwd: opts.cwd,
      tty: opts.tty,
      cols: process.stdout?.columns || 80,
      rows: process.stdout?.rows || 24,
      timeoutMs: opts.timeoutMs,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      onStarted: ({ mode }) => {
        if (mode === 'pty' && process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
          process.stdin.setRawMode(true);
          changedRaw = true;
        }
      }
    });

    cleanupTerminal();
    process.exitCode = result.code;
  } catch (err) {
    cleanupTerminal();
    if (err instanceof SuwinClientError) {
      console.error(`suwin: ${err.message}`);
    } else {
      console.error(`suwin error: ${err.message}`);
    }
    process.exitCode = 1;
  }
}

main();
