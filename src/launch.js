import { spawn } from 'node:child_process';
import { quoteWindowsArgument } from './command.js';

export function serviceArguments(script, options) {
  const args = [script, options.foreground ? '--foreground' : '--daemon'];
  if (options.active) args.push('--active', `${options.activeDuration}ms`);
  if (options.port) args.push('--port', String(options.port));
  if (!options.tray) args.push('--no-tray');
  return args;
}

const psString = value => "'" + value.replace(/'/g, "''") + "'";

export function elevationScript(executable, args, { foreground = false } = {}) {
  const commandLine = args.map(quoteWindowsArgument).join(' ');
  return `$ErrorActionPreference = 'Stop'; try { Start-Process -FilePath ${psString(executable)} -ArgumentList ${psString(commandLine)} -Verb RunAs -WindowStyle ${foreground ? 'Normal' : 'Hidden'} | Out-Null } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
}

// The normal UAC consent prompt is the only path to an elevated supervisor.
// Use this exact Node executable, and retain every requested service option.
export function launchService(script, options, elevated) {
  const args = serviceArguments(script, options);
  return new Promise((resolve, reject) => {
    if (elevated) {
      const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    } else {
      const encoded = Buffer.from(elevationScript(process.execPath, args, options), 'utf16le').toString('base64');
      const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let errorText = '';
      child.stderr.on('data', data => { errorText = (errorText + data.toString()).slice(-4000); });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(errorText.trim() || 'The UAC request was cancelled or failed')));
    }
  });
}
