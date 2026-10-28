First public release of Security Undertaking Windows (suwin).

- Per-user install, live update and complete uninstall with locked npm dependencies.
- Manual startup through normal UAC consent; no autostart, machine PATH or scheduled tasks.
- Native tray UI on a separate worker, with timed activation and immediate revocation.
- ConPTY terminals, resize propagation and transparent Ctrl+C handling.
- Kill-on-close Job Objects, command timeouts and connection keepalive.
- Rotating audit logs that omit command arguments and environment values.
- Windows x64 and ARM64 CI on Node.js 22, 24 and 26.

Download `suwin-1.0.0.zip`, extract it and run `node scripts/install.js` from its
folder. Node.js 22 or newer with npm is required. Open a new terminal afterwards
and run `suwinsvc` when you need an administrative session. See README.md for
source installation, operation, updates and uninstall.
