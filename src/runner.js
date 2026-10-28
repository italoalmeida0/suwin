// runner.js - Process spawning, streaming and lifecycle management
import { spawn, exec } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {
  REASON_EXITED,
  REASON_INTERRUPTED,
  REASON_TERMINATED,
  REASON_TIMEOUT,
  EXIT_INTERRUPTED,
  EXIT_TERMINATED,
  EXIT_TIMEOUT
} from './protocol.js';

// Internal Windows cmd.exe built-in commands
const CMD_BUILTINS = new Set([
  'assoc', 'attrib', 'break', 'call', 'cd', 'chcp', 'chdir', 'cls', 'color',
  'copy', 'date', 'del', 'dir', 'echo', 'endlocal', 'erase', 'exit', 'for',
  'ftype', 'goto', 'help', 'if', 'md', 'mkdir', 'mklink', 'move', 'path',
  'pause', 'popd', 'prompt', 'pushd', 'rd', 'rem', 'ren', 'rename', 'rmdir',
  'set', 'setlocal', 'shift', 'start', 'time', 'title', 'type', 'ver', 'verify',
  'vol'
]);

function resolveExecutableWindows(prog, cwd = process.cwd()) {
  if (path.extname(prog)) return prog;
  const pathExt = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';');
  const pathenv = (process.env.PATH || '').split(path.delimiter);
  for (const dir of [cwd, ...pathenv]) {
    for (const ext of pathExt) {
      const candidate = path.join(dir, prog + ext);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {}
    }
  }
  return prog;
}

export function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      exec(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore', windowsHide: true }, () => {});
    } catch {
      // Ignore
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Ignore
      }
    }
  }
}

export class Session {
  constructor(options, handlers = {}) {
    this.id = options.id || Math.random().toString(36).substring(2, 10);
    this.argv = options.argv || [];
    this.shell = Boolean(options.shell);
    this.cwd = options.cwd || process.cwd();
    this.timeoutMs = options.timeoutMs || 0;
    this.handlers = handlers; // { onStdout, onStderr, onExit }

    this.child = null;
    this.pid = 0;
    this.mode = 'pipe';
    this.exitReason = null;
    this.syntheticCode = null;
    this.terminated = false;
    this.timeoutTimer = null;
    this.startedAt = new Date();
  }

  start() {
    let executable = '';
    let args = [];

    // Format child environment
    const childEnv = { ...process.env };
    if (Array.isArray(this.argv.env)) {
      for (const item of this.argv.env) {
        const idx = item.indexOf('=');
        if (idx > 0) {
          childEnv[item.substring(0, idx)] = item.substring(idx + 1);
        }
      }
    }

    if (this.shell) {
      executable = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
      const cmdLine = this.argv.join(' ');
      args = process.platform === 'win32' ? ['/d', '/s', '/c', cmdLine] : ['-c', cmdLine];
      this.command = cmdLine;
    } else {
      if (!this.argv.length) {
        throw new Error('No command provided in argv');
      }

      const rawProg = this.argv[0];
      const progLower = rawProg.toLowerCase();

      if (process.platform === 'win32') {
        const resolved = resolveExecutableWindows(rawProg, this.cwd);
        const resolvedLower = resolved.toLowerCase();

        if (CMD_BUILTINS.has(progLower) || resolvedLower.endsWith('.cmd') || resolvedLower.endsWith('.bat')) {
          executable = 'cmd.exe';
          const cmdLine = this.argv.join(' ');
          args = ['/d', '/s', '/c', cmdLine];
          this.command = cmdLine;
        } else if (progLower === 'cmd' || progLower === 'cmd.exe') {
          executable = 'cmd.exe';
          args = this.argv.slice(1);
          // Turn off pipe echo so input lines are not duplicated on screen
          if (!args.some(a => /^[/-]q$/i.test(a))) {
            args.unshift('/q');
          }
          this.command = this.argv.join(' ');
        } else {
          executable = resolved;
          args = this.argv.slice(1);
          this.command = this.argv.join(' ');
        }
      } else {
        executable = rawProg;
        args = this.argv.slice(1);
        this.command = this.argv.join(' ');
      }
    }

    // Spawn process with windowsHide: true (guarantees NO window ever flashes on screen)
    try {
      this.child = spawn(executable, args, {
        cwd: this.cwd,
        env: childEnv,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      throw new Error(`Failed to spawn ${executable}: ${err.message}`);
    }

    this.pid = this.child.pid;

    if (this.timeoutMs > 0) {
      this.timeoutTimer = setTimeout(() => {
        this.terminate(REASON_TIMEOUT, EXIT_TIMEOUT);
      }, this.timeoutMs);
    }

    this.child.stdout.on('data', (chunk) => {
      if (this.handlers.onStdout) {
        this.handlers.onStdout(chunk);
      }
    });

    this.child.stderr.on('data', (chunk) => {
      if (this.handlers.onStderr) {
        this.handlers.onStderr(chunk);
      }
    });

    this.child.on('error', (err) => {
      if (this.handlers.onStderr) {
        this.handlers.onStderr(Buffer.from(`Process error: ${err.message}\n`));
      }
    });

    this.child.on('close', (code) => {
      this._handleExit(code);
    });

    return {
      id: this.id,
      pid: this.pid,
      mode: this.mode,
      command: this.command,
      cwd: this.cwd
    };
  }

  _handleExit(code) {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }

    let finalCode = code ?? 0;
    let finalReason = this.exitReason || REASON_EXITED;

    if (this.syntheticCode !== null) {
      finalCode = this.syntheticCode;
    }

    if (this.handlers.onExit) {
      this.handlers.onExit({
        code: finalCode,
        reason: finalReason,
        elapsedMs: Date.now() - this.startedAt.getTime()
      });
    }
  }

  resize(cols, rows) {
    // Ignored in pipe mode
  }

  writeStdin(chunk) {
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(chunk);
    }
  }

  endStdin() {
    if (this.child?.stdin?.writable) {
      this.child.stdin.end();
    }
  }

  interrupt() {
    this.terminate(REASON_INTERRUPTED, EXIT_INTERRUPTED);
  }

  terminate(reason = REASON_TERMINATED, code = EXIT_TERMINATED) {
    if (this.terminated) return;
    this.terminated = true;
    this.exitReason = reason;
    this.syntheticCode = code;

    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }

    if (this.pid) {
      killProcessTree(this.pid);
    }
  }
}
