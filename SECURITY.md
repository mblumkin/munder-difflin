# Security Policy

## Scope

Munder Difflin is a **local-first desktop app**. It spawns local processes in PTYs and
reads/writes files under directories you register. It opens **no network listeners
beyond a local Unix domain socket** used for the in-app hook server, and has no auth or
remote surface by design.

## Supported versions

This is an early prototype. Security fixes target the `main` branch only.

| Version | Supported |
|---|---|
| `main` | ✅ |
| older tags | ❌ |

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

- Use GitHub's **private vulnerability reporting**: the *Security → Report a
  vulnerability* tab on https://github.com/chaitanyagiri/munder-difflin, **or**
- Email **girichaitanya11@gmail.com** with a description, reproduction steps, and
  impact.

You can expect an acknowledgement within a few days. Once a fix is available we'll
credit you (unless you prefer to stay anonymous).

## Notes for reviewers

- Renderer ↔ main IPC goes through a typed `contextBridge` (`window.cth`); the renderer
  has no direct Node access (`nodeIntegration: false`, `contextIsolation: true`).
- All `fs:*` / `git:*` IPC calls are sandboxed and path-validated in the main process,
  rooted at an agent's working directory.
- The hive commits to a local git repo from a **single committer** (the main process);
  agents only write plain files.

### Integration and provider credentials on macOS

`integration-secrets.json` is encrypted at rest with Electron `safeStorage`; secret
values are never returned to the renderer. That does **not** currently establish a
code-identity boundary against another process running as the same macOS user. In the
current packaged build, a separate Electron process can claim the same application name
and reach the same Safe Storage keychain material. Treat stored integration credentials
as available to local agents and other same-user processes.

When stored secrets are present, Munder Difflin warns at every macOS startup. The warning
is removed only when no secrets remain. A stronger boundary requires an App Owner release
decision: sign with a stable Apple Team identity and provisioning profile, store secrets
in a Data Protection Keychain access group authorized for that identity, migrate existing
Safe Storage values, and verify upgrade/key-rotation behavior. Electron `safeStorage`
does not expose an API for selecting that access group, so this must not be approximated
with an application-name check or another key stored beside the ciphertext.
