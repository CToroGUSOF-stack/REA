# Live native debugging with x64dbg (design spec)

Status: proposal. Relates to issue #1267. Only the discovery increment described
below is implemented; every later increment needs a separate maintainer scope
decision under the fail-closed rules in `CONTRIBUTING.md`.

## Problem

REA offers persistent GDB and Rizin debugger sessions on Linux, but no Windows
user-mode debugger. Windows PE investigations that need live state currently
have no first-class provider. x64dbg is a widely used, open-source (GPL-3.0)
Windows debugger that users can bring themselves.

## Transport candidates

| Candidate                                      | Notes                                                                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| x64dbg-automate (MIT) — **preferred**          | Plugin plus client exposing a request/response automation protocol. MIT licensing keeps REA's distribution clean; the plugin stays a BYO install next to x64dbg. |
| Custom REA plugin bridge (like the Cutter one) | Full control over the wire format, but REA would own and maintain a native x64dbg plugin and its compatibility with x64dbg releases.                             |

The preferred candidate is x64dbg-automate, kept out of REA's packages and
discovered at runtime like other BYO tools. The final choice is part of the
scope decision for the first session increment.

## Identity model

A live session has at least two distinct process identities:

- **debugger PID**: the x64dbg/x32dbg process REA would talk to;
- **inferior PID**: the debuggee, launched or attached by the debugger.

They are never interchangeable. Evidence must record both, together with the
debugger build architecture (x64dbg for 64-bit, x32dbg for 32-bit inferiors) and
the executable path. A debugger restart or inferior change invalidates any
session identity derived from the previous pair.

## Non-goals

- Anti-debug bypass, anti-anti-debug plugins, or protection recovery.
- Kernel debugging or drivers.
- Bundling or auto-installing x64dbg or any plugin.
- Remote or networked debugging.

## Increments

1. **Discovery (this change).** `discover_x64dbg` (CLI `discover-x64dbg`)
   resolves `REA_X64DBG_COMMAND` or well-known install locations under
   `ProgramFiles`, `ProgramFiles(x86)`, `LOCALAPPDATA\Programs`, and the system
   drive. It reports the PE machine type read from the file header. It never
   launches x64dbg (x64dbg has no documented non-interactive `--help` or
   version flag), never attaches, and writes nothing. On non-Windows hosts it
   returns `unsupported_platform` with an explicit reason. A configured path that
   does not exist returns `configured_path_not_found` without falling back to
   well-known locations. Discovery failures are returned as statuses, never
   thrown, so an absent provider cannot break peer providers.
2. **Session start / attach (not implemented).** Requires a maintainer scope
   decision covering target execution, cleanup, and identity verification.
3. **Breakpoints, memory reads/writes, stepping (not implemented).** Requires a
   further scope decision; writes and target mutation are a separate expansion.

## Open questions

- Version reporting without launching: reading the PE version resource is
  possible but not yet implemented; `version` is reported as unknown.
- Plugin presence detection for x64dbg-automate (plugin directory layout).
- Job Object and cleanup semantics for an attached inferior on close.
