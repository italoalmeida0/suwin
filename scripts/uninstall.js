// scripts/uninstall.js - Uninstalls suwin cleanly from ~/.suwin and removes from PATH
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const suwinHome = path.join(os.homedir(), '.suwin');
const binDir = path.join(suwinHome, 'bin');

console.log('\x1b[36m==========================================================\x1b[0m');
console.log('\x1b[36m  Uninstalling suwin\x1b[0m');
console.log('\x1b[36m==========================================================\x1b[0m');

// 1. Stop running service
console.log('\x1b[33m[1/3] Stopping any running suwin service...\x1b[0m');
const stateDirs = [
  path.join(suwinHome, 'state'),
  suwinHome,
  'C:\\suwin',
  path.join(process.env.LOCALAPPDATA || '', 'suwin')
];

for (const sDir of stateDirs) {
  const epFile = path.join(sDir, 'endpoint.json');
  if (fs.existsSync(epFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(epFile, 'utf8'));
      if (data.port) {
        fetch(`http://127.0.0.1:${data.port}/v1/quit`, { method: 'POST' }).catch(() => {});
      }
    } catch {}
    try {
      fs.unlinkSync(epFile);
    } catch {}
  }
}

// 2. Remove ~/.suwin/bin from User PATH
console.log('\x1b[33m[2/3] Removing ~/.suwin/bin from User PATH...\x1b[0m');
try {
  const getPathCmd = `powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path', 'User')"`;
  const currentPath = execSync(getPathCmd, { encoding: 'utf8', windowsHide: true }).trim();

  const parts = currentPath.split(';').map(p => p.trim()).filter(Boolean);
  const filtered = parts.filter(p => p.toLowerCase() !== binDir.toLowerCase());

  if (filtered.length !== parts.length) {
    const newPath = filtered.join(';');
    const escaped = newPath.replace(/'/g, "''");
    const setPathCmd = `powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path', '${escaped}', 'User')"`;
    execSync(setPathCmd, { stdio: 'ignore', windowsHide: true });
    console.log('  ✓ Removed ~/.suwin/bin from User PATH in Registry.');
  } else {
    console.log('  ✓ ~/.suwin/bin was not in User PATH.');
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
  console.log(`  Notice: Could not update PATH: ${err.message}`);
}

// 3. Remove ~/.suwin directory
console.log('\x1b[33m[3/3] Removing ~/.suwin files...\x1b[0m');

try {
  if (fs.existsSync('C:\\suwin')) {
    fs.rmSync('C:\\suwin', { recursive: true, force: true });
  }
} catch {}

try {
  // If running from inside ~/.suwin, delete files and folder via background cmd
  const cmd = `cmd.exe /c timeout /t 1 /nobreak >nul & rmdir /s /q "${suwinHome}"`;
  execSync(`start "" ${cmd}`, { stdio: 'ignore', windowsHide: true });
} catch {
  try {
    fs.rmSync(suwinHome, { recursive: true, force: true });
  } catch {}
}

console.log('\n\x1b[32m✓ suwin has been completely uninstalled from your system!\x1b[0m');
