# Security Undertaking Windows (`suwin`)

[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-green.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20(x64%20%7C%20ARM64)-blue.svg)]()
[![License](https://img.shields.io/badge/License-MIT-brightgreen.svg)](LICENSE)

**Security Undertaking Windows (`suwin`)** is a lightweight, human-in-the-loop administrative session coordinator and execution supervisor for Windows environments.

It introduces a strictly supervised workflow where administrative commands can only be executed during an explicit, time-bounded authorization window approved through an interactive Windows notification area (System Tray) monitor.

---

## Key Features

* **🛡️ Human-in-the-Loop Security Model**: The unprivileged client tool (`suwin`) cannot self-authorize. Commands are only permitted when an authorized supervisor window is actively engaged by the operator.
* **🟢 Native Win32 System Tray**: Real-time visual status indicator in the Windows taskbar tray powered natively via Win32 API bindings (`koffi`), featuring an interactive context menu to authorize sessions (15m, 1h, 3h, 24h) or instantly revoke access.
* **🚀 Flicker-Free Execution**: Spawns processes silently (`windowsHide: true`) with direct duplex standard I/O streaming. No flickering `conhost.exe` consoles or disrupted focus.
* **📁 Fully Self-Contained (`~/.suwin`)**: Completely isolated in your user home directory. Does not touch `C:\` or write system-wide files.
* **⚡ 100% Pure Node.js & Windows Native APIs**: Runs on official signed runtimes without custom unverified binaries, ensuring zero antivirus or SmartScreen friction.

---

## Architecture Overview

```
                      +---------------------------------------+
                      | Windows Notification Area (Tray Icon) |
                      |   [Active (green) / Inactive (gray)]  |
                      +-------------------+-------------------+
                                          | Operator interaction
                                          v
+-----------------------+     WebSocket     +---------------------------------------+
|  User Terminal        | ================= |  Supervisor Service (suwinsvc)        |
|  $ suwin whoami /priv |  (ws://127.0.0.1) |  - State coordinator (active/inactive)|
+-----------------------+                   |  - Ephemeral timer & session governor |
                                            +-------------------+-------------------+
                                                                | Spawns child process
                                                                v
                                            +---------------------------------------+
                                            | Target Command (elevated execution)   |
                                            | - windowsHide: true                   |
                                            | - Direct pipe streaming (in/out/err)  |
                                            +---------------------------------------+
```

---

## Installation

Run the automated local installer:

```powershell
node scripts/install.js
```

This sets up:
* **Installation Root**: `~/.suwin/` (`C:\Users\<user>\.suwin`)
  * `bin/`: Wrapper commands (`suwin.cmd`, `suwinsvc.cmd`, `uninstall-suwin.cmd`)
  * `node/`: Application runtime and dependencies
  * `state/`: Runtime session endpoint (`endpoint.json`) and service log
* **PATH Configuration**: Adds `~/.suwin/bin` to your User `PATH` environment variable.
* **Autostart**: *Disabled*. `suwinsvc` is only invoked when you choose to start it.

---

## Quick Start

### 1. Launch the Supervisor Service

In any PowerShell or Command Prompt terminal:

```powershell
suwinsvc
```

* Prompts for Windows Administrator privileges via UAC once.
* Starts the supervisor service in the background and **immediately frees your terminal**.
* Mounts the **Security Undertaking Windows** shield icon in the notification area (system tray).

### 2. Authorize an Execution Window

1. Click or right-click the **suwin** shield icon in your taskbar tray (check the `^` overflow menu if Windows grouped your icons).
2. Select your desired authorization duration:
   * **Activate for 15 minutes**
   * **Activate for 1 hour**
   * **Activate for 3 hours**
   * **Activate for 24 hours**
3. The icon illuminates green to indicate the session window is authorized. Hovering over the icon displays the live countdown.

### 3. Execute Supervised Tasks

Run your commands using `suwin` from any standard console:

```powershell
# Inspect administrative token privileges
suwin whoami /priv

# Manage Windows services
suwin net stop wuauserv

# Launch interactive administrative shells
suwin powershell -NoLogo

# Execute complex shell pipelines
suwin --shell "ipconfig /flushdns && echo Flush completed."
```

### 4. Revoke or Deactivate

At any time, right-click the tray icon and select **Deactivate**. All active sessions are terminated immediately, and subsequent command requests are rejected until re-authorized.

---

## Command Reference

### `suwin` (Execution Client)

```
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
```

### `suwinsvc` (Supervisor Daemon)

```
Usage:
  suwinsvc [options]

Options:
  -f, --foreground      run in foreground terminal monitor instead of background
  -a, --active [dur]    start with authorized session window active (default: 15m)
  -p, --port <port>     port to bind (default: random free loopback port)
  --no-tray             disable the system tray icon
  -h, --help            show this help
```

---

## Uninstallation

To cleanly remove `suwin` and restore your system:

```powershell
uninstall-suwin
```

Or run:
```powershell
node ~\.suwin\uninstall.js
```

This stops running supervisor services, removes `~/.suwin/bin` from your user `PATH`, and deletes the `~/.suwin` directory completely.

---

## License

This project is licensed under the [MIT License](LICENSE).
