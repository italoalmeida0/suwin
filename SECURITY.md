# Security policy

Use GitHub's private vulnerability reporting at
https://github.com/italoalmeida0/suwin/security/advisories/new for security issues.
Do not post credentials or active endpoint files in public issues.

The supported release is the latest tagged version. Dependencies are locked and
the Windows x64/ARM64 CI checks Node.js 22, 24 and 26.

## Privilege boundary

The supervisor starts elevated through the normal Windows UAC consent prompt.
It does not bypass UAC. Installation itself is per-user and requires no scheduled
task, Windows service, machine PATH change or automatic startup.

Activation authorizes **all local processes that can reach the supervisor** for
that period. There is no per-command authentication, user allowlist or application
sandbox. Do not activate it on a machine with untrusted local users or processes.
It binds to IPv4 loopback and rejects browser Origin headers; those measures do
not turn the activation window into per-process authentication.

Activation credentials stay in supervisor memory. `endpoint.json` contains a
separate stop-only capability used by setup. It cannot activate the supervisor.
Anyone who can modify the per-user installation can modify code that will run
the next time its owner approves UAC. Treat that directory like trusted code.

Every command starts suspended, enters its own kill-on-close Job Object and is
then resumed. Disconnect, explicit cancellation, expiry, timeout and supervisor
death terminate its descendants. This controls child process lifetime, not the
lasting effects of administrative commands (for example, starting a Windows service).

Audit records contain program names and lifecycle metadata. Arguments, environment
values, stdout and stderr are excluded. Logs remain in the per-user state folder.
