import fs from 'node:fs';
import path from 'node:path';

const BUILTINS = new Set(('assoc break call cd chdir cls color copy date del dir echo endlocal erase exit for ftype goto if md mkdir mklink move path pause popd prompt pushd rd rem ren rename rmdir set setlocal shift start time title type ver verify vol').split(' '));
const PROTECTED_ENV = new Set(['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC']);

// Windows environment names are case insensitive. Keeping both Path and PATH
// makes process creation and executable lookup disagree about which one to use.
export function mergeEnvironment(overrides = {}, base = process.env) {
  const values = new Map();
  for (const source of [base, overrides]) {
    for (const [key, value] of Object.entries(source)) {
      if (!key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid environment variable');
      const name = process.platform === 'win32' ? key.toUpperCase() : key;
      if (source === overrides && PROTECTED_ENV.has(name) && values.has(name)) continue;
      values.set(name, { key, value });
    }
  }
  return Object.fromEntries([...values.values()].map(({ key, value }) => [key, value]));
}

function envValue(env, name, fallback = '') {
  const key = Object.keys(env).find(key => key.toUpperCase() === name);
  return key ? env[key] : fallback;
}

export function resolveExecutableWindows(program, cwd, env) {
  const hasPath = /[\\/]/.test(program) || path.win32.isAbsolute(program);
  const dirs = hasPath ? [''] : [cwd, ...envValue(env, 'PATH').split(';')];
  const extensions = path.win32.extname(program)
    ? [''] : ['', ...envValue(env, 'PATHEXT', '.COM;.EXE;.BAT;.CMD').split(';').filter(ext => /^\.[\w]+$/.test(ext))];
  for (let dir of dirs) {
    dir = dir.replace(/^"(.*)"$/, '$1');
    const candidate = path.resolve(cwd, dir, program);
    for (const ext of extensions) {
      try {
        if (fs.statSync(candidate + ext).isFile()) return candidate + ext;
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
    }
  }
  throw new Error(`Command not found: ${program}`);
}

// CommandLineToArgvW / Microsoft CRT escaping, including trailing backslashes.
export function quoteWindowsArgument(value) {
  if (value && !/[\s"]/.test(value)) return value;
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

function quoteCmdArgument(value, batch) {
  const quoted = '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  const escape = text => text.replace(/([()\[\]%!^"`<>&|;, *?])/g, '^$1');
  const escaped = escape(quoted);
  // A batch shim expands %* into another command, requiring a second escape.
  return batch ? escape(escaped) : escaped;
}

export function prepareCommand({ argv, shell = false, cwd, env }) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('A nonempty argv array of strings is required');
  if (!fs.statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  if (process.platform !== 'win32') {
    return shell
      ? { executable: '/bin/sh', args: ['-c', argv.join(' ')], command: argv.join(' ') }
      : { executable: argv[0], args: argv.slice(1), command: argv.join(' ') };
  }
  const cmd = path.join(envValue(env, 'SYSTEMROOT', 'C:\\Windows'), 'System32', 'cmd.exe');
  if (shell) return { executable: cmd, commandLine: `${quoteWindowsArgument(cmd)} /d /s /c "${argv.join(' ')}"`, command: argv.join(' ') };
  const builtin = BUILTINS.has(argv[0].toLowerCase());
  const executable = builtin ? argv[0] : resolveExecutableWindows(argv[0], cwd, env);
  if (builtin || /\.(cmd|bat)$/i.test(executable)) {
    if (argv.some(arg => /[\r\n]/.test(arg))) throw new Error('Batch arguments cannot contain newlines');
    const escapedCommand = executable.replace(/([()\[\]%!^"`<>&|;, *?])/g, '^$1');
    const args = argv.slice(1).map(arg => argv[0].toLowerCase() === 'echo'
      ? arg.replace(/([()\[\]%!^"`<>&|;, *?])/g, '^$1') : quoteCmdArgument(arg, !builtin));
    const line = [escapedCommand, ...args].join(' ');
    return { executable: cmd, commandLine: `${quoteWindowsArgument(cmd)} /d /s /v:off /c "${line}"`, command: line };
  }
  const commandLine = [executable, ...argv.slice(1)].map(quoteWindowsArgument).join(' ');
  return { executable, commandLine, command: commandLine };
}
