// Setup deliberately imports only Node builtins: the uninstaller must not load
// the installed Koffi DLL that it is about to remove.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { processAlive } from './maintenance.js';

const source = fileURLToPath(new URL('../', import.meta.url));
const ps = value => "'" + value.replace(/'/g, "''") + "'";
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
export const defaultRoot = () => path.join(os.homedir(), '.suwin');

function execute(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'inherit', ...options });
    let output = '';
    child.stdout?.on('data', data => { output += data; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(`${path.basename(file)} exited with code ${code}`)));
  });
}

export function parseSetupArgs(args) {
  const options = { root: defaultRoot(), path: true };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) options.root = path.resolve(args[++i]);
    else if (args[i] === '--no-path') options.path = false;
    else if (args[i] === '--help' || args[i] === '-h') options.help = true;
    else throw new Error(`Unknown or incomplete setup option: ${args[i]}`);
  }
  return options;
}

export function validateRoot(root) {
  root = path.resolve(root);
  if (same(root, path.parse(root).root) || same(root, os.homedir()) || same(root, source)) throw new Error('Refusing to use a system, home or source directory as the installation root');
  if (fs.existsSync(root)) {
    if (fs.lstatSync(root).isSymbolicLink() || !same(fs.realpathSync(root), root)) throw new Error('The installation root must be a real directory, not a link');
    const entries = fs.readdirSync(root);
    const marker = path.join(root, 'install.json');
    const legacy = fs.existsSync(path.join(root, 'node', 'bin', 'suwinsvc.js')) && fs.existsSync(path.join(root, 'bin', 'suwin.cmd'));
    if (entries.length && !fs.existsSync(marker) && !legacy) throw new Error('The target is not an empty directory or a suwin installation');
    if (fs.existsSync(marker)) {
      const info = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (info.product !== 'suwin' || info.schema !== 1 || !same(info.root, root)) throw new Error('Invalid suwin installation marker');
    }
    for (const entry of ['node', 'bin', 'state']) {
      const item = path.join(root, entry);
      if (fs.existsSync(item) && fs.lstatSync(item).isSymbolicLink()) throw new Error(`Refusing linked installation folder: ${entry}`);
    }
  }
  return root;
}

function removeInside(root, target) {
  const relative = path.relative(root, path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing deletion outside the installation');
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

async function powershell(script, capture = false) {
  return execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    capture ? { stdio: ['ignore', 'pipe', 'inherit'] } : {});
}

export function changePathValue(current, bin, add) {
  const parts = (current ? current.split(';') : []).filter(part => !part || !same(part.trim().replace(/^"(.*)"$/, '$1'), bin));
  if (add) parts.push(bin);
  return parts.join(';');
}

async function userPath(bin, add) {
  // Preserve both literal %VARIABLE% entries and the registry value kind.
  const stored = JSON.parse((await powershell(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); $value=''; $kind='ExpandString';
    if ($key) { if ($key.GetValueNames() -contains 'Path') { $value=$key.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $kind=$key.GetValueKind('Path').ToString() }; $key.Dispose() };
    @{value=$value;kind=$kind} | ConvertTo-Json -Compress`, true)).trim());
  if (!['String', 'ExpandString'].includes(stored.kind)) throw new Error('The user PATH has an unsupported registry value type');
  const current = stored.value || '';
  const updated = changePathValue(current, bin, add);
  const present = current.split(';').some(part => part && same(part.trim().replace(/^"(.*)"$/, '$1'), bin));
  if (updated === current) return present;
  await powershell(`$ErrorActionPreference='Stop'; $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment');
    try { $kind=[Enum]::Parse([Microsoft.Win32.RegistryValueKind],${ps(stored.kind)}); $key.SetValue('Path',${ps(updated)},$kind) } finally { $key.Dispose() };
    Add-Type -Namespace Suwin -Name EnvironmentBroadcast -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll",CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr h,uint m,System.UIntPtr w,string l,uint f,uint t,out System.UIntPtr r);';
    $result=[UIntPtr]::Zero; [Suwin.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff,0x1a,[UIntPtr]::Zero,'Environment',2,3000,[ref]$result) | Out-Null`);
  return present;
}

async function stopService(root) {
  const endpointFile = path.join(root, 'state', 'endpoint.json');
  if (!fs.existsSync(endpointFile)) return;
  const ep = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
  if (!Number.isInteger(ep.port) || ep.port < 1 || ep.port > 65535 || !Number.isInteger(ep.pid) || ep.pid <= 0) throw new Error('Invalid service endpoint; quit suwin from the tray before retrying');
  let status;
  try {
    const response = await fetch(`http://127.0.0.1:${ep.port}/v1/status`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    status = await response.json();
  } catch (error) {
    if (processAlive(ep.pid)) throw new Error(`The supervisor is still running but cannot be reached; quit it from the tray: ${error.message}`);
    return;
  }
  if (status.pid !== ep.pid || status.instance !== ep.instance) throw new Error('Service identity does not match the installation; refusing to stop it');
  if (!status.home || !same(status.home, root) || typeof ep.stopToken !== 'string') throw new Error('Quit the older supervisor from the tray before updating or uninstalling');
  const response = await fetch(`http://127.0.0.1:${ep.port}/v1/quit`, { method: 'POST', headers: { 'x-suwin-stop-token': ep.stopToken }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`The supervisor refused shutdown (HTTP ${response.status}); files have not been removed`);
  const deadline = Date.now() + 15000;
  while (processAlive(ep.pid) && Date.now() < deadline) await delay(100);
  if (processAlive(ep.pid)) throw new Error('The supervisor has not exited; files have not been removed');
}

function npmCli() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const found = candidates.find(file => file && fs.existsSync(file) && /npm-cli\.js$/i.test(file));
  if (!found) throw new Error('npm was not found next to Node.js. Install the official Node.js distribution including npm');
  return found;
}

export async function performSetup(mode, options) {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw new Error('suwin requires Windows x64 or ARM64');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required');
  const root = validateRoot(options.root);
  if (mode === 'uninstall' && !fs.existsSync(root)) { console.log('suwin is not installed.'); return; }
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  if (!fs.existsSync(path.join(root, 'install.json')) && !fs.existsSync(path.join(root, 'bin', 'suwin.cmd'))) {
    if (mode !== 'install') throw new Error('This directory is not an installed copy of suwin');
    fs.writeFileSync(path.join(root, 'install.json'), JSON.stringify({ schema: 1, product: 'suwin', root, path: false, status: 'incomplete' }));
  }
  const maintenanceFile = path.join(root, 'state', 'maintenance.json');
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(maintenanceFile, JSON.stringify({ pid: process.pid, token, operation: mode }));
  const bin = path.join(root, 'bin');
  const app = path.join(root, 'node');
  const stage = path.join(root, `.stage-${token}`);
  const backup = path.join(root, `.previous-${token}`);
  let swapped = false, pathAdded = false, pathRemoved = false;
  const originals = new Map(['package.json', 'install.json', 'uninstall.js', 'bin/suwin.cmd', 'bin/suwinsvc.cmd', 'bin/uninstall-suwin.cmd'].map(name => {
    const file = path.join(root, name);
    return [file, fs.existsSync(file) ? fs.readFileSync(file) : null];
  }));
  try {
    if (mode === 'install') {
      const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
      console.log(`Preparing suwin ${pkg.version} for ${root}...`);
      fs.mkdirSync(stage);
      for (const name of ['src', 'bin', 'scripts', 'package.json', 'package-lock.json', 'LICENSE', 'README.md']) fs.cpSync(path.join(source, name), path.join(stage, name), { recursive: true });
      await execute(process.execPath, [npmCli(), 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage });
      await execute(process.execPath, ['--input-type=module', '-e', 'import koffi from "koffi"; import {isWindowsElevated} from "./src/windows.js"; console.log(`Native runtime ready (${process.arch}, koffi ${koffi.version})`); isWindowsElevated();'], { cwd: stage });
      await stopService(root);
      if (fs.existsSync(app)) fs.renameSync(app, backup);
      try { fs.renameSync(stage, app); swapped = true; }
      catch (error) { if (fs.existsSync(backup)) fs.renameSync(backup, app); throw error; }
      fs.mkdirSync(bin, { recursive: true });
      // Pin the exact Node runtime used by the installer; no PATH-based runtime lookup.
      for (const [name, script] of [['suwin', 'suwin'], ['suwinsvc', 'suwinsvc']]) {
        fs.writeFileSync(path.join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0..\\node\\bin\\${script}.js" %*\r\n`, 'utf8');
      }
      fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
      fs.writeFileSync(path.join(root, 'uninstall.js'), `import {runSetup} from './node/src/setup.js'; await runSetup('uninstall',['--root',${JSON.stringify(root)},...process.argv.slice(2)]);\n`);
      // Leave the batch context before self-removal. Otherwise cmd.exe tries to
      // reopen the deleted file and replaces a successful Node exit with code 1.
      fs.writeFileSync(path.join(bin, 'uninstall-suwin.cmd'), `@echo off\r\n(goto) 2>nul & "${process.execPath}" "%~dp0..\\uninstall.js" %*\r\n`, 'utf8');
      if (options.path) pathAdded = !(await userPath(bin, true));
      fs.writeFileSync(path.join(root, 'install.json'), JSON.stringify({ schema: 1, product: 'suwin', version: pkg.version, root, path: options.path, node: process.execPath }, null, 2));
      if (fs.existsSync(backup)) {
        try { removeInside(root, backup); }
        catch (error) { console.warn(`The previous version could not be removed: ${error.message}`); }
      }
      console.log(`Installed suwin ${pkg.version} in ${root}.\nAutostart: disabled. Open a new terminal and run suwinsvc when needed.`);
    } else if (mode === 'uninstall') {
      await stopService(root);
      const markerFile = path.join(root, 'install.json');
      const marker = fs.existsSync(markerFile) ? JSON.parse(fs.readFileSync(markerFile)) : { path: true };
      if (options.path && marker.path) { await userPath(bin, false); pathRemoved = true; }
      // validateRoot verified ownership, the absolute target and absence of links.
      validateRoot(root);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
      console.log('suwin stopped and uninstalled.');
    } else throw new Error('Unknown setup operation');
  } catch (error) {
    if (swapped) {
      removeInside(root, app);
      if (fs.existsSync(backup)) fs.renameSync(backup, app);
      for (const [file, previous] of originals) {
        if (previous === null) fs.rmSync(file, { force: true });
        else if (!fs.existsSync(file) || !fs.readFileSync(file).equals(previous)) fs.writeFileSync(file, previous);
      }
    }
    if (pathAdded) await userPath(bin, false);
    if (pathRemoved && fs.existsSync(root)) await userPath(bin, true);
    throw error;
  } finally {
    if (fs.existsSync(stage)) removeInside(root, stage);
    try { if (JSON.parse(fs.readFileSync(maintenanceFile)).token === token) fs.unlinkSync(maintenanceFile); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function runSetup(mode, args) {
  const options = parseSetupArgs(args);
  if (options.help) { console.log(`node scripts/${mode}.js [--root <directory>] [--no-path]\nDefault: ${defaultRoot()} (per-user, no autostart)`); return; }
  const root = validateRoot(options.root);
  const key = crypto.createHash('sha256').update(root.toLowerCase()).digest('hex');
  const entry = fileURLToPath(new URL('./setup-entry.js', import.meta.url));
  const command = [entry, mode, '--root', root, ...(options.path ? [] : ['--no-path'])].map(ps).join(' ');
  // The OS mutex is held by PowerShell, not by an installed native addon. The
  // builtin-only Node child can remove its own JS files without locking a DLL.
  await powershell(`$ErrorActionPreference='Stop'; $locked=$false; $exitCode=1; $mutex=[Threading.Mutex]::new($false,${ps(`Global\\suwin-setup-${key}`)});
    try { try { $locked=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }; if (!$locked) { throw 'Another suwin setup is already running' }; & ${ps(process.execPath)} ${command}; $exitCode=$LASTEXITCODE }
    catch { [Console]::Error.WriteLine($_.Exception.Message) } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }; exit $exitCode`);
}
