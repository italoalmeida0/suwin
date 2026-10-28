import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { prepareCommand, mergeEnvironment } from './command.js';
import { WindowsProcess } from './windows.js';
import {
  REASON_EXITED, REASON_INTERRUPTED, REASON_TERMINATED, REASON_TIMEOUT,
  EXIT_INTERRUPTED, EXIT_TERMINATED, EXIT_TIMEOUT
} from './protocol.js';

export class Session {
  constructor(options, handlers = {}) {
    this.id = options.id || crypto.randomBytes(8).toString('hex');
    this.options = options;
    this.handlers = handlers;
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.mode = 'pipe';
    this.pid = 0;
    this.child = null;
    this.exitReason = REASON_EXITED;
    this.syntheticCode = null;
    this.terminated = false;
    this.finished = false;
    this.timeoutTimer = null;
    this.startedAt = new Date();
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
  }

  start() {
    const env = mergeEnvironment(this.options.env);
    const command = prepareCommand({ ...this.options, cwd: this.cwd, env });
    this.command = command.command;
    if (process.platform === 'win32') {
      this.native = new WindowsProcess({ ...this.options, ...command, cwd: this.cwd, env }, {
        onStdout: chunk => this.handlers.onStdout?.(chunk),
        onStderr: chunk => this.handlers.onStderr?.(chunk),
        onExit: code => this.handleExit(code)
      });
      const info = this.native.start();
      this.pid = info.pid;
      this.mode = info.mode;
    } else {
      if (this.options.tty) throw new Error('TTY is only supported on Windows');
      this.child = spawn(command.executable, command.args, { cwd: this.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.pid = this.child.pid;
      this.child.stdout.on('data', chunk => this.handlers.onStdout?.(chunk));
      this.child.stderr.on('data', chunk => this.handlers.onStderr?.(chunk));
      this.child.stdin.on('error', () => {});
      this.child.once('error', error => {
        this.syntheticCode = 1;
        this.handlers.onStderr?.(Buffer.from(`${error.message}\n`));
      });
      this.child.once('close', code => { this.killPortable(); this.handleExit(code ?? 1); });
    }
    if (this.options.timeoutMs > 0) this.timeoutTimer = setTimeout(() => this.terminate(REASON_TIMEOUT, EXIT_TIMEOUT), this.options.timeoutMs);
    return { id: this.id, pid: this.pid, mode: this.mode, command: this.command, cwd: this.cwd };
  }

  handleExit(code) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timeoutTimer);
    const info = { code: this.syntheticCode ?? code, reason: this.exitReason, elapsedMs: Date.now() - this.startedAt.getTime() };
    this.handlers.onExit?.(info);
    this.resolveDone(info);
  }

  resize(cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || cols > 500 || rows < 1 || rows > 500) return;
    this.native?.resize(cols, rows);
  }

  writeStdin(chunk, onWritten) {
    if (this.finished) return;
    if (this.native) this.native.write(chunk, onWritten);
    else if (this.child?.stdin?.writable) this.child.stdin.write(chunk, onWritten);
  }

  endStdin() {
    if (this.native) this.native.endInput();
    else this.child?.stdin?.end();
  }

  interrupt() {
    if (this.finished || this.terminated) return;
    if (this.mode === 'pty') {
      // The application owns terminal Ctrl+C: it may cancel an operation, read
      // the byte in raw mode, or exit. Only lifecycle events terminate the job.
      this.native.write(Buffer.from([3]));
    } else this.terminate(REASON_INTERRUPTED, EXIT_INTERRUPTED);
  }

  killPortable() {
    if (!this.pid) return;
    try { process.kill(-this.pid, 'SIGKILL'); } catch {}
  }

  terminate(reason = REASON_TERMINATED, code = EXIT_TERMINATED) {
    if (this.finished || this.terminated) return;
    this.terminated = true;
    this.exitReason = reason;
    this.syntheticCode = code;
    clearTimeout(this.timeoutTimer);
    if (this.native) this.native.terminate(code);
    else this.killPortable();
  }

  pauseOutput() {
    this.native?.pause();
    this.child?.stdout.pause();
    this.child?.stderr.pause();
  }

  resumeOutput() {
    this.native?.resume();
    this.child?.stdout.resume();
    this.child?.stderr.resume();
  }
}
