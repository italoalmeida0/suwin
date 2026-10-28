// Win32 process ownership and ConPTY using the existing koffi dependency.
// https://learn.microsoft.com/windows/console/creating-a-pseudoconsole-session
import koffi from 'koffi';
import crypto from 'node:crypto';

let bindings;
function api() {
  if (bindings) return bindings;
  const kernel = koffi.load('kernel32.dll');
  const startup = koffi.struct('SUWIN_STARTUPINFO', {
    cb: 'uint32', lpReserved: 'void*', lpDesktop: 'void*', lpTitle: 'void*',
    dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32',
    dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32',
    dwFlags: 'uint32', wShowWindow: 'uint16', cbReserved2: 'uint16',
    lpReserved2: 'void*', hStdInput: 'void*', hStdOutput: 'void*', hStdError: 'void*'
  });
  const startupEx = koffi.struct('SUWIN_STARTUPINFOEX', { StartupInfo: startup, lpAttributeList: 'void*' });
  const overlapped = koffi.struct('SUWIN_OVERLAPPED', {
    Internal: 'uintptr_t', InternalHigh: 'uintptr_t', Offset: 'uint32', OffsetHigh: 'uint32', hEvent: 'void*'
  });
  koffi.struct('SUWIN_PROCESS_INFORMATION', { hProcess: 'void*', hThread: 'void*', dwProcessId: 'uint32', dwThreadId: 'uint32' });
  const basicLimit = koffi.struct('SUWIN_JOB_BASIC_LIMIT', {
    PerProcessUserTimeLimit: 'int64', PerJobUserTimeLimit: 'int64', LimitFlags: 'uint32',
    MinimumWorkingSetSize: 'size_t', MaximumWorkingSetSize: 'size_t', ActiveProcessLimit: 'uint32',
    Affinity: 'uintptr_t', PriorityClass: 'uint32', SchedulingClass: 'uint32'
  });
  const io = koffi.struct('SUWIN_IO_COUNTERS', {
    ReadOperationCount: 'uint64', WriteOperationCount: 'uint64', OtherOperationCount: 'uint64',
    ReadTransferCount: 'uint64', WriteTransferCount: 'uint64', OtherTransferCount: 'uint64'
  });
  const extendedLimit = koffi.struct('SUWIN_JOB_EXTENDED_LIMIT', {
    BasicLimitInformation: basicLimit, IoInfo: io, ProcessMemoryLimit: 'size_t', JobMemoryLimit: 'size_t',
    PeakProcessMemoryUsed: 'size_t', PeakJobMemoryUsed: 'size_t'
  });
  bindings = {
    startupEx, extendedLimit, basicLimit, overlapped,
    CreateJobObject: kernel.func('void* __stdcall CreateJobObjectW(void*, const char16_t*)'),
    SetInformationJobObject: kernel.func('int __stdcall SetInformationJobObject(void*, int, const void*, uint32)'),
    AssignProcessToJobObject: kernel.func('int __stdcall AssignProcessToJobObject(void*, void*)'),
    TerminateJobObject: kernel.func('int __stdcall TerminateJobObject(void*, uint32)'),
    CloseHandle: kernel.func('int __stdcall CloseHandle(void*)'),
    GetLastError: kernel.func('uint32 __stdcall GetLastError()'),
    CreatePipe: kernel.func('int __stdcall CreatePipe(_Out_ void**, _Out_ void**, void*, uint32)'),
    CreateNamedPipe: kernel.func('void* __stdcall CreateNamedPipeW(const char16_t*, uint32, uint32, uint32, uint32, uint32, uint32, void*)'),
    CreateFile: kernel.func('void* __stdcall CreateFileW(const char16_t*, uint32, uint32, void*, uint32, uint32, void*)'),
    ConnectNamedPipe: kernel.func('int __stdcall ConnectNamedPipe(void*, void*)'),
    CreateEvent: kernel.func('void* __stdcall CreateEventW(void*, int, int, const char16_t*)'),
    ResetEvent: kernel.func('int __stdcall ResetEvent(void*)'),
    SetHandleInformation: kernel.func('int __stdcall SetHandleInformation(void*, uint32, uint32)'),
    InitializeAttributes: kernel.func('int __stdcall InitializeProcThreadAttributeList(void*, uint32, uint32, _Inout_ size_t*)'),
    UpdateAttributes: kernel.func('int __stdcall UpdateProcThreadAttribute(void*, uint32, uintptr_t, void*, size_t, void*, void*)'),
    DeleteAttributes: kernel.func('void __stdcall DeleteProcThreadAttributeList(void*)'),
    CreateProcess: kernel.func('int __stdcall CreateProcessW(const char16_t*, void*, void*, void*, int, uint32, void*, const char16_t*, const SUWIN_STARTUPINFOEX*, _Out_ SUWIN_PROCESS_INFORMATION*)'),
    ResumeThread: kernel.func('uint32 __stdcall ResumeThread(void*)'),
    TerminateProcess: kernel.func('int __stdcall TerminateProcess(void*, uint32)'),
    WaitForSingleObject: kernel.func('uint32 __stdcall WaitForSingleObject(void*, uint32)'),
    GetExitCodeProcess: kernel.func('int __stdcall GetExitCodeProcess(void*, _Out_ uint32*)'),
    PeekNamedPipe: kernel.func('int __stdcall PeekNamedPipe(void*, void*, uint32, void*, _Out_ uint32*, void*)'),
    ReadFile: kernel.func('int __stdcall ReadFile(void*, _Out_ void*, uint32, _Out_ uint32*, void*)'),
    WriteFile: kernel.func('int __stdcall WriteFile(void*, const void*, uint32, _Out_ uint32*, void*)'),
    GetOverlappedResult: kernel.func('int __stdcall GetOverlappedResult(void*, void*, _Out_ uint32*, int)'),
    CancelIoEx: kernel.func('int __stdcall CancelIoEx(void*, void*)')
  };
  try {
    const coord = koffi.struct('SUWIN_COORD', { X: 'int16', Y: 'int16' });
    bindings.CreatePseudoConsole = kernel.func('CreatePseudoConsole', 'int32', [coord, 'void*', 'void*', 'uint32', koffi.out(koffi.pointer('void*'))]);
    bindings.ResizePseudoConsole = kernel.func('ResizePseudoConsole', 'int32', ['void*', coord]);
    bindings.ClosePseudoConsole = kernel.func('void __stdcall ClosePseudoConsole(void*)');
  } catch {
    // Pipe mode is still available on Windows versions without ConPTY.
  }
  return bindings;
}

export function isWindowsElevated() {
  const kernel = koffi.load('kernel32.dll');
  const advapi = koffi.load('advapi32.dll');
  const currentProcess = kernel.func('void* __stdcall GetCurrentProcess()');
  const openToken = advapi.func('int __stdcall OpenProcessToken(void*, uint32, _Out_ void**)');
  const getInfo = advapi.func('int __stdcall GetTokenInformation(void*, int, _Out_ void*, uint32, _Out_ uint32*)');
  const close = kernel.func('int __stdcall CloseHandle(void*)');
  const token = [null];
  if (!openToken(currentProcess(), 8, token)) return false;
  try {
    const elevation = Buffer.alloc(4);
    return Boolean(getInfo(token[0], 20, elevation, 4, [0]) && elevation.readUInt32LE(0));
  } finally {
    close(token[0]);
  }
}

export function enableWindowsInterrupts() {
  // PowerShell and other launchers can pass down the console's "ignore Ctrl+C"
  // attribute. Reset it for this supervisor so ConPTY children can handle SIGINT.
  const kernel = koffi.load('kernel32.dll');
  kernel.func('int __stdcall SetConsoleCtrlHandler(void*, int)')(null, 0);
}

export function cancelTrayMenu(hwnd) {
  const user = koffi.load('user32.dll');
  user.func('int __stdcall PostMessageW(void*, uint32, uintptr_t, intptr_t)')(hwnd, 0x400 + 101, 0, 0);
}

export function acquireWindowsServiceLock(name) {
  const kernel = koffi.load('kernel32.dll');
  const create = kernel.func('void* __stdcall CreateMutexW(void*, int, const char16_t*)');
  const setError = kernel.func('void __stdcall SetLastError(uint32)');
  const getError = kernel.func('uint32 __stdcall GetLastError()');
  const close = kernel.func('int __stdcall CloseHandle(void*)');
  setError(0);
  const handle = create(null, 0, name);
  const error = getError();
  if (!handle) throw new Error(`Could not acquire the service mutex (Windows error ${error})`);
  if (error === 183) { close(handle); throw new Error('Another suwin service is already running'); }
  // A kernel mutex disappears on process death, so there is no stale lock file
  // to race over when two launchers try to recover a crashed supervisor.
  return () => close(handle);
}

export class WindowsProcess {
  constructor(options, handlers) {
    this.options = options;
    this.handlers = handlers;
    this.native = api();
    this.job = null;
    this.process = null;
    this.pty = null;
    this.input = null;
    this.inputIO = null;
    this.inputEvent = null;
    this.activeWrite = null;
    this.outputs = [];
    this.queue = [];
    this.queuedBytes = 0;
    this.writing = false;
    this.inputClosed = false;
    this.outputPaused = false;
    this.exited = false;
    this.finished = false;
    this.closingPty = false;
    this.resizing = false;
    this.nextSize = null;
    this.timer = null;
    this.exitCode = 1;
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
  }

  check(result, operation) {
    if (!result) throw new Error(`${operation} failed (Windows error ${this.native.GetLastError()})`);
  }

  pipe() {
    const read = [null], write = [null];
    this.check(this.native.CreatePipe(read, write, null, 64 * 1024), 'CreatePipe');
    return [read[0], write[0]];
  }

  inputPipe() {
    const n = this.native;
    const name = `\\\\.\\pipe\\suwin-${process.pid}-${crypto.randomBytes(16).toString('hex')}`;
    const invalid = handle => !handle || koffi.address(handle) === BigInt.asUintN(koffi.sizeof('void*') * 8, -1n);
    // The child's read handle stays synchronous (as ConPTY requires), while
    // the host write handle uses overlapped I/O. Stalled stdin never occupies
    // a libuv worker or blocks other sessions' resize/console teardown.
    const write = n.CreateNamedPipe(name, 0x40000000 | 0x80000 | 2, 8, 1, 65536, 65536, 0, null);
    this.check(!invalid(write), 'CreateNamedPipe');
    let read = null;
    try {
      read = n.CreateFile(name, 0x80000000, 0, null, 3, 0x80, null);
      this.check(!invalid(read), 'Open stdin pipe');
      this.inputEvent = n.CreateEvent(null, 1, 0, null);
      this.check(this.inputEvent, 'CreateEvent');
      this.inputIO = koffi.alloc(n.overlapped, 1);
      koffi.encode(this.inputIO, n.overlapped, { hEvent: this.inputEvent });
      // Our read side has already connected, so ERROR_PIPE_CONNECTED is success.
      const connected = n.ConnectNamedPipe(write, this.inputIO);
      this.check(connected || n.GetLastError() === 535, 'ConnectNamedPipe');
      return [read, write];
    } catch (error) {
      if (!invalid(read)) n.CloseHandle(read);
      n.CloseHandle(write);
      if (this.inputIO) koffi.free(this.inputIO);
      if (this.inputEvent) n.CloseHandle(this.inputEvent);
      this.inputIO = null;
      this.inputEvent = null;
      throw error;
    }
  }

  start() {
    const n = this.native;
    const { commandLine, executable, env, cwd, tty, cols = 80, rows = 24 } = this.options;
    if (tty && !n.CreatePseudoConsole) throw new Error('TTY requires Windows 10 1809 or newer; use --no-tty');
    let attributes = null, attributesInitialized = false, inherited = null, thread = null;
    const childHandles = [];
    try {
      this.job = n.CreateJobObject(null, null);
      this.check(this.job, 'CreateJobObject');
      const limits = Buffer.alloc(koffi.sizeof(n.extendedLimit));
      limits.writeUInt32LE(0x2000, koffi.offsetof(n.basicLimit, 'LimitFlags'));
      this.check(n.SetInformationJobObject(this.job, 9, limits, limits.length), 'SetInformationJobObject');
      const [inRead, inWrite] = this.inputPipe();
      childHandles.push(inRead);
      this.input = inWrite;
      const [outRead, outWrite] = this.pipe();
      childHandles.push(outWrite);
      this.outputs.push({ handle: outRead, stderr: false });
      const si = { cb: koffi.sizeof(n.startupEx), dwFlags: 0x100,
        hStdInput: tty ? null : inRead, hStdOutput: tty ? null : outWrite };
      if (tty) {
        const hpc = [null];
        const hr = n.CreatePseudoConsole({ X: cols, Y: rows }, inRead, outWrite, 0, hpc);
        if (hr < 0) throw new Error(`CreatePseudoConsole failed (HRESULT 0x${(hr >>> 0).toString(16)})`);
        this.pty = hpc[0];
      } else {
        const [errRead, errWrite] = this.pipe();
        childHandles.push(errWrite);
        this.outputs.push({ handle: errRead, stderr: true });
        si.hStdError = errWrite;
        for (const handle of childHandles) this.check(n.SetHandleInformation(handle, 1, 1), 'SetHandleInformation');
      }
      const size = [0];
      n.InitializeAttributes(null, 1, 0, size);
      attributes = koffi.alloc('uint8', Number(size[0]));
      this.check(n.InitializeAttributes(attributes, 1, 0, size), 'InitializeProcThreadAttributeList');
      attributesInitialized = true;
      if (tty) {
        this.check(n.UpdateAttributes(attributes, 0, 0x20016, this.pty, koffi.sizeof('void*'), null, null), 'Attach ConPTY');
      } else {
        inherited = koffi.alloc('void*', childHandles.length);
        koffi.encode(inherited, 'void*', childHandles, childHandles.length);
        this.check(n.UpdateAttributes(attributes, 0, 0x20002, inherited, childHandles.length * koffi.sizeof('void*'), null, null), 'Restrict inherited handles');
      }
      const line = Buffer.from(commandLine + '\0', 'utf16le');
      const block = Buffer.from(Object.keys(env).sort((a, b) => a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0)
        .map(key => `${key}=${env[key]}`).join('\0') + '\0\0', 'utf16le');
      const pi = {};
      const flags = 0x80000 | 0x400 | 0x4 | (tty ? 0 : 0x8000000);
      this.check(n.CreateProcess(executable, line, null, null, tty ? 0 : 1, flags, block, cwd, { StartupInfo: si, lpAttributeList: attributes }, pi), 'CreateProcess');
      this.process = pi.hProcess;
      thread = pi.hThread;
      this.pid = pi.dwProcessId;
      // The child cannot execute a single instruction before the job owns it.
      this.check(n.AssignProcessToJobObject(this.job, this.process), 'AssignProcessToJobObject');
      if (n.ResumeThread(thread) === 0xffffffff) this.check(false, 'ResumeThread');
      this.timer = setInterval(() => this.poll(), 10);
      return { pid: this.pid, mode: tty ? 'pty' : 'pipe' };
    } catch (error) {
      if (this.process) n.TerminateProcess(this.process, 1);
      this.closeJob();
      this.closeInput();
      if (this.process) n.CloseHandle(this.process);
      this.process = null;
      this.exited = true;
      this.handlers = {};
      this.closePty();
      this.timer = setInterval(() => this.poll(), 10);
      throw error;
    } finally {
      if (thread) n.CloseHandle(thread);
      for (const handle of childHandles) n.CloseHandle(handle);
      if (attributesInitialized) n.DeleteAttributes(attributes);
      if (attributes) koffi.free(attributes);
      if (inherited) koffi.free(inherited);
    }
  }

  poll() {
    if (this.finished) return;
    const n = this.native;
    if (this.writing) {
      const written = [0];
      const ok = n.GetOverlappedResult(this.input, this.inputIO, written, 0);
      if (ok || n.GetLastError() !== 996) this.completeInputWrite(ok, written[0]);
    }
    if (!this.outputPaused) {
      for (const stream of this.outputs) {
        let budget = 256 * 1024;
        while (stream.handle && budget > 0 && !this.outputPaused) {
          const available = [0];
          if (!n.PeekNamedPipe(stream.handle, null, 0, null, available, null)) {
            n.CloseHandle(stream.handle);
            stream.handle = null;
            break;
          }
          if (!available[0]) break;
          const data = Buffer.allocUnsafe(Math.min(available[0], 32768, budget));
          const read = [0];
          if (!n.ReadFile(stream.handle, data, data.length, read, null)) break;
          if (!read[0]) break;
          budget -= read[0];
          (stream.stderr ? this.handlers.onStderr : this.handlers.onStdout)?.(data.subarray(0, read[0]));
        }
      }
    }
    if (!this.exited && n.WaitForSingleObject(this.process, 0) === 0) {
      const code = [1];
      n.GetExitCodeProcess(this.process, code);
      this.exitCode = code[0];
      this.exited = true;
      this.closeJob();
      this.closeInput();
      this.closePty();
    }
    if (this.exited && !this.closingPty && !this.pty && !this.writing && this.outputs.every(stream => !stream.handle)) {
      this.finished = true;
      clearInterval(this.timer);
      if (this.process) n.CloseHandle(this.process);
      this.process = null;
      this.handlers.onExit?.(this.exitCode);
      this.resolveDone();
    }
  }

  closeJob() {
    if (!this.job) return;
    this.native.CloseHandle(this.job);
    this.job = null;
  }

  closePty() {
    if (!this.pty || this.closingPty || this.resizing) return;
    this.closingPty = true;
    // Close may emit a final frame. Drain output while it runs on a worker.
    this.native.ClosePseudoConsole.async(this.pty, () => {
      this.pty = null;
      this.closingPty = false;
    });
  }

  write(data, onWritten) {
    if (!data.length || this.inputClosed || !this.input || this.exited) { onWritten?.(); return; }
    if (this.queuedBytes + data.length > 4 * 1024 * 1024) throw new Error('Command stdin queue is full');
    for (let offset = 0; offset < data.length; offset += 32768) {
      this.queue.push({ data: Buffer.from(data.subarray(offset, offset + 32768)),
        onWritten: offset + 32768 >= data.length ? onWritten : null });
    }
    this.queuedBytes += data.length;
    this.flushInput();
  }

  flushInput() {
    if (this.writing || !this.input) return;
    if (this.inputClosed && !this.queue.length) return this.closeInput();
    const item = this.queue.shift();
    if (!item) return;
    const chunk = item.data;
    const memory = koffi.alloc('uint8', chunk.length);
    koffi.encode(memory, 'uint8', chunk, chunk.length);
    this.activeWrite = { ...item, memory };
    this.writing = true;
    const written = [0];
    koffi.encode(this.inputIO, this.native.overlapped, { hEvent: this.inputEvent });
    this.native.ResetEvent(this.inputEvent);
    const ok = this.native.WriteFile(this.input, memory, chunk.length, written, this.inputIO);
    if (ok || this.native.GetLastError() !== 997) this.completeInputWrite(ok, written[0]);
  }

  completeInputWrite(ok, written) {
    const item = this.activeWrite;
    this.activeWrite = null;
    this.writing = false;
    koffi.free(item.memory);
    this.queuedBytes -= item.data.length;
    if (!ok || this.exited) {
      this.closeInput();
    } else {
      if (written < item.data.length) {
        this.queue.unshift({ data: item.data.subarray(written), onWritten: item.onWritten });
        this.queuedBytes += item.data.length - written;
      } else item.onWritten?.();
      this.flushInput();
    }
  }

  endInput() {
    if (this.options.tty) return;
    this.inputClosed = true;
    this.flushInput();
  }

  closeInput() {
    this.inputClosed = true;
    if (!this.input) return;
    if (this.writing) { this.native.CancelIoEx(this.input, this.inputIO); return; }
    this.native.CloseHandle(this.input);
    this.input = null;
    if (this.inputIO) koffi.free(this.inputIO);
    if (this.inputEvent) this.native.CloseHandle(this.inputEvent);
    this.inputIO = null;
    this.inputEvent = null;
    this.queue = [];
    this.queuedBytes = 0;
  }

  resize(cols, rows) {
    if (!this.pty || this.exited || this.closingPty) return;
    this.nextSize = { X: cols, Y: rows };
    if (this.resizing) return;
    const resize = () => {
      const size = this.nextSize;
      this.nextSize = null;
      this.resizing = true;
      this.native.ResizePseudoConsole.async(this.pty, size, () => {
        this.resizing = false;
        if (this.exited) this.closePty();
        else if (this.nextSize) resize();
      });
    };
    resize();
  }

  terminate(code = 143) { if (this.job) this.native.TerminateJobObject(this.job, code); }
  pause() { this.outputPaused = true; }
  resume() { this.outputPaused = false; }
}
