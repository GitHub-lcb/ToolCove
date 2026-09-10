# Security Policy

## Supported versions

Only the latest release of ToolCove receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's private reporting
channel instead:

1. Go to the repository's **Security → Advisories → Report a vulnerability**
   (`https://github.com/GitHub-lcb/ToolCove/security/advisories/new`).
2. Describe the issue, affected version, and reproduction steps.

You can expect an initial response within a few days. Please give us a chance to ship a fix
before public disclosure.

## Scope

In scope:

- The desktop app, the browser build, and the bundled sync server (`server/`).
- Anything that leaks user data, bypasses the local-only guarantee, or breaks the sync
  encryption model (zero-knowledge: the server must never see plaintext).

Out of scope:

- Vulnerabilities in third-party services you configure yourself (your own AI endpoint, your own
  sync deployment), including plain-HTTP self-hosting.
- Issues that require an attacker to already control your machine or your OS account.

## Design guarantees worth knowing when testing

- All user data is stored locally (`<app-data>/*.json`); nothing is uploaded by default.
- AI requests and HTTP proxying go only to endpoints you configure explicitly.
- Cloud sync is end-to-end encrypted (PBKDF2 600k + AES-256-GCM per record); the server stores
  ciphertext, HMAC-obfuscated IDs, timestamps, and anonymous device IDs only.
- Secrets at rest (API keys, sync password, DB passwords) are protected with OS-level facilities
  (Windows DPAPI) on the desktop build.

If you find a deviation from any of these, that's a security bug — please report it.
