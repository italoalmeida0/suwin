// scripts/install.js - Installs suwin into ~/.suwin and configures User PATH
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoNodeDir = path.resolve(__dirname, '..');

const suwinHome = path.join(os.homedir(), '.suwin');
const binDir = path.join(suwinHome, 'bin');
const nodeDest = path.join(suwinHome, 'node');
const stateDir = path.join(suwinHome, 'state');

console.log('\x1b[36m==========================================================\x1b[0m');
console.log(`\x1b[36m  Installing suwin into ${suwinHome}\x1b[0m`);
console.log('\x1b[36m==========================================================\x1b[0m');

// 1. Create directories
console.log('\x1b[33m[1/4] Creating directories...\x1b[0m');
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(nodeDest, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

// Place type: module package.json in suwinHome so all .js files are ES modules
fs.writeFileSync(path.join(suwinHome, 'package.json'), JSON.stringify({ name: 'suwin-home', type: 'module' }, null, 2));

// 2. Copy application files
console.log('\x1b[33m[2/4] Copying files...\x1b[0m');
fs.copyFileSync(path.join(repoNodeDir, 'package.json'), path.join(nodeDest, 'package.json'));
fs.cpSync(path.join(repoNodeDir, 'src'), path.join(nodeDest, 'src'), { recursive: true, force: true });
fs.cpSync(path.join(repoNodeDir, 'bin'), path.join(nodeDest, 'bin'), { recursive: true, force: true });

const nodeModulesDest = path.join(nodeDest, 'node_modules');
if (!fs.existsSync(nodeModulesDest)) {
  const nodeModulesSrc = path.join(repoNodeDir, 'node_modules');
  if (fs.existsSync(nodeModulesSrc)) {
    fs.cpSync(nodeModulesSrc, nodeModulesDest, { recursive: true });
  } else {
    console.log('  Installing npm dependencies in destination...');
    execSync('npm install --omit=dev --silent', { cwd: nodeDest, stdio: 'inherit', windowsHide: true });
  }
}

// 3. Generate wrapper executables in ~/.suwin/bin
console.log('\x1b[33m[3/4] Generating CLI executable wrappers...\x1b[0m');

const suwinCmd = `@echo off\r\nnode "%~dp0..\\node\\bin\\suwin.js" %*\r\n`;
fs.writeFileSync(path.join(binDir, 'suwin.cmd'), suwinCmd, 'ascii');

const suwinsvcCmd = `@echo off\r\nnode "%~dp0..\\node\\bin\\suwinsvc.js" %*\r\n`;
fs.writeFileSync(path.join(binDir, 'suwinsvc.cmd'), suwinsvcCmd, 'ascii');

const uninstallCmd = `@echo off\r\nnode "%~dp0..\\uninstall.js"\r\n`;
fs.writeFileSync(path.join(binDir, 'uninstall-suwin.cmd'), uninstallCmd, 'ascii');

// Copy uninstall script
fs.copyFileSync(path.join(__dirname, 'uninstall.js'), path.join(suwinHome, 'uninstall.js'));

// 4. Update User PATH in Windows Registry
console.log('\x1b[33m[4/4] Adding ~/.suwin/bin to User PATH...\x1b[0m');

try {
  const getPathCmd = `powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path', 'User')"`;
  const currentPath = execSync(getPathCmd, { encoding: 'utf8', windowsHide: true }).trim();

  const parts = currentPath.split(';').map(p => p.trim()).filter(Boolean);
  const alreadyInPath = parts.some(p => p.toLowerCase() === binDir.toLowerCase());

  if (!alreadyInPath) {
    const newPath = currentPath ? `${currentPath};${binDir}` : binDir;
    const escaped = newPath.replace(/'/g, "''");
    const setPathCmd = `powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path', '${escaped}', 'User')"`;
    execSync(setPathCmd, { stdio: 'ignore', windowsHide: true });
    console.log('  ✓ Added ~/.suwin/bin to User PATH in Registry.');
  } else {
    console.log('  ✓ ~/.suwin/bin is already in User PATH.');
  }

  // Broadcast WM_SETTINGCHANGE
  try {
    const broadcastPs = `
      $csharp = '[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'
      Add-Type -Namespace Win32 -Name Native -MemberDefinition $csharp -ErrorAction SilentlyContinue
      $res = [System.UIntPtr]::Zero
      [Win32.Native]::SendMessageTimeout([System.IntPtr]0xffff, 0x001A, [System.UIntPtr]::Zero, "Environment", 2, 5000, [ref]$res) | Out-Null
    `;
    execSync(`powershell -NoProfile -Command "${broadcastPs.replace(/\n/g, ' ')}"`, { stdio: 'ignore', windowsHide: true });
  } catch {}
} catch (err) {
  console.log(`  Notice: Could not automatically update PATH: ${err.message}`);
}

console.log('\n\x1b[32m✓ Installation complete!\x1b[0m');
console.log(`  Location:      ${suwinHome}`);
console.log(`  PATH added:    ${binDir}`);
console.log(`  Auto-start:    DISABLED (manual start only, as requested)\n`);
console.log('\x1b[36mTo start the supervisor service in background with Tray Icon:\x1b[0m');
console.log('  \x1b[33msuwinsvc\x1b[0m\n');
console.log('\x1b[36mTo run commands in a supervised session:\x1b[0m');
console.log('  \x1b[33msuwin whoami /priv\x1b[0m\n');
console.log('\x1b[36mTo uninstall anytime:\x1b[0m');
console.log('  \x1b[33muninstall-suwin\x1b[0m  (or run ' + path.join(suwinHome, 'uninstall.js') + ')\n');
