# Security Undertaking Windows (`suwin`)

[![CI](https://github.com/italoalmeida0/suwin/actions/workflows/ci.yml/badge.svg)](https://github.com/italoalmeida0/suwin/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![Windows](https://img.shields.io/badge/Windows-x64%20%7C%20ARM64-blue.svg)](#requirements)
[![MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Run administrative Windows commands from an ordinary terminal during a time window
you authorize. `suwinsvc` requests elevation through the normal Windows UAC prompt,
then lives in the notification area. `suwin` sends commands to it and streams their
input, output and exit codes back to your terminal.

Installation is **per-user**, and startup is **manual**. There is no scheduled task,
Windows service, machine PATH modification or automatic startup.

## Requirements

- Windows x64 or ARM64 with a supported **Node.js LTS release, version 22 or newer**,
  including npm. Download Node.js from [nodejs.org](https://nodejs.org/en/download).
- ConPTY-capable Windows for interactive terminals (Windows 10 1809 or newer).
- Git is needed only for the source installation below.

The project uses Node.js, `ws` and the native `koffi` addon to call Windows APIs.
No Go toolchain or locally compiled helper executable is required. Antivirus and
SmartScreen behavior depends on your system; no exemption or bypass is installed.

## Install

Use a **normal PowerShell terminal**; the installer does not need administrator rights.

### Download a release

1. Download `suwin-1.0.0.zip` from the [latest release](https://github.com/italoalmeida0/suwin/releases/latest).
2. Extract it and open PowerShell in the extracted `suwin-1.0.0` folder.
3. Run:

```powershell
node scripts/install.js
```

The installer downloads the exact dependencies from `package-lock.json` using
`npm ci`, checks that the native addon loads and installs into:

```text
C:\Users\<you>\.suwin\
  bin\             suwin.cmd, suwinsvc.cmd, uninstall-suwin.cmd
  node\            application and npm dependencies
  state\           endpoint.json and rotating suwinsvc.log
  install.json     installation metadata
  uninstall.js     installed uninstaller
```

It adds only `~\.suwin\bin` to your **user PATH**. **Open a new terminal** after
installation. It does not start the supervisor.

Release archives include `SHA256SUMS.txt` as a separate download. To check an archive:

```powershell
Get-FileHash .\suwin-1.0.0.zip -Algorithm SHA256
```

### Install from source

```powershell
git clone https://github.com/italoalmeida0/suwin.git
cd suwin
node scripts/install.js
```

There is no separate `npm install` step for installation: the installer runs
`npm ci` in its staging directory.

Optional setup flags:

```powershell
node scripts/install.js --root D:\Tools\suwin
node scripts/install.js --no-path
```

An existing target must be a suwin installation or an empty directory. A custom
root changes the installation location, not the per-user/manual-start policy.
With `--no-path`, invoke the wrappers using their full paths.

## Use

Start the supervisor when you need it:

```powershell
suwinsvc
```

Accept the UAC prompt. The launcher reports readiness after the supervisor and tray
icon have initialized. The supervisor starts **inactive**.

Click or right-click its tray icon and activate for **15 minutes, 1 hour, 3 hours
or 24 hours**. Then use an ordinary terminal:

```powershell
suwin whoami /priv
suwin ipconfig /flushdns
suwin powershell -NoLogo
suwin -t nvim
suwin --timeout 30s --shell "net stop wuauserv && net start wuauserv"
```

TTY mode is selected automatically when stdin and stdout are terminals. `-t`
forces ConPTY; `--no-tty` uses pipes with separate stdout and stderr. Terminal
input, escape sequences and size changes are forwarded. In TTY mode, Ctrl+C,
including repeated presses, belongs to the application and does not start an
automatic termination timer.

Use **Deactivate** to revoke the window and terminate running commands, or **Quit**
to close the supervisor. Expiration also terminates running sessions.

## Command options

```text
suwin [options] <command> [args...]
suwin [options] --shell "<command line>"

  -t, --tty          force ConPTY
      --no-tty       use standard I/O pipes
      --shell        interpret the command line with cmd.exe
      --cwd <dir>    working directory (default: the caller's)
      --timeout <d>  command timeout: 500ms, 30s, 5m, 1h, or bare seconds
      --version     print the version
  -h, --help        print help
```

Arguments and the caller's environment are forwarded. Windows system variables
(`SystemRoot`, `windir`, `SystemDrive`, `ComSpec`) retain the supervisor's values.
PATH/PATHEXT lookup uses the caller's environment. `.cmd` and `.bat` shims are supported.

The command's exit code is returned. Explicit timeouts use **124**; forced
termination uses **143**; interruption in pipe mode uses **130**. Connection or
startup errors use **1**. In TTY mode the application's actual exit code is preserved.

Advanced supervisor options:

```text
suwinsvc --foreground          show the terminal monitor
suwinsvc --port 51234          choose a loopback port
suwinsvc --no-tray             omit the notification icon
suwinsvc --active 15m          explicitly authorize at startup
```

`--active` still requires an already elevated launcher or normal UAC consent.
Without that option, the supervisor starts inactive. `SUWIN_AUTOACTIVATE` provides
the same explicit startup setting. `SUWIN_HOME` and `SUWIN_DIR` override runtime
discovery locations for development; installed operation normally needs neither.

## Update

Download/extract a new release, or update your source checkout, then rerun:

```powershell
node scripts/install.js
```

Dependencies are prepared in a staging directory first. The installer then stops
the existing supervisor and its commands, replaces the application, and preserves
the state folder and logs. It leaves the supervisor stopped until you run
`suwinsvc` again. If updating an older pre-release without shutdown support, quit
that version from its tray icon before installing.

## Uninstall

```powershell
uninstall-suwin
```

Or, from PowerShell:

```powershell
node "$env:USERPROFILE\.suwin\uninstall.js"
```

The uninstaller requests shutdown using a stop-only capability, waits for the
supervisor to exit, removes its entry from the user PATH and deletes its installation.
It does not scan or delete legacy system folders. If shutdown cannot be confirmed,
it reports an error and keeps the application files. Custom installations include
their own `uninstall.js` with the correct location.

## Security and process lifetime

An active window authorizes **any local process that can reach the supervisor**.
There is no per-command authentication or per-application allowlist. Activate it
only when you trust the local environment, and deactivate it when finished.
See [SECURITY.md](SECURITY.md) for the exact trust boundary.

Each command is placed into a kill-on-close Windows Job Object before it runs.
Disconnects, timeout, revocation and supervisor death terminate its process tree.
The native tray uses a separate worker so an open menu does not block command I/O,
keepalive or authorization expiration.

Audit logs record activation, program names, working directories and session
lifecycle. They omit arguments, environment values and command output. The log
rotates at 1 MiB and keeps one previous file.

## Development and verification

```powershell
npm ci
npm run check
npm test
npm audit --omit=dev
```

CI tests Windows x64 and ARM64 with Node.js 22, 24 and 26. Coverage includes actual
ConPTY input/resize, repeated Ctrl+C, process-tree cleanup, supervisor/client death,
streaming backpressure, live updates and self-uninstall. Setup tests use temporary
installation roots. The real user PATH round trip runs in disposable CI machines.
Interactive desktop smoke tests can be enabled with `SUWIN_TRAY_TEST=1`.

Tagged releases are published only after the CI matrix succeeds, with a source ZIP
and SHA-256 checksum. The ZIP installs native dependencies for the target machine.

## License

[MIT](LICENSE) — Copyright © 2026 Italo Almeida.
