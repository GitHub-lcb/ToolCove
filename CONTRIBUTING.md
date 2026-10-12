# Contributing to ToolCove

Thanks for your interest! ToolCove（工具湾）is a free and open-source (MIT) developer workbench
that runs both as a Windows desktop app (Tauri 2) and as a static web app in the browser.

感谢参与贡献。无论是 Issue、文档还是代码 PR 都欢迎。

## Getting started

Requirements: Node.js ≥ 20, Rust (MSVC toolchain) for the desktop shell.

```bash
npm install
npm run dev            # browser dev server (frontend only)
npm run tauri dev      # desktop app with hot reload
npm test               # unit tests (vitest, node environment)
npm run build          # frontend production build
cd src-tauri && cargo test   # Rust tests
```

`npm run dev` and `npm run dev:mobile` slide to the next free port when 1420 / 1430 are taken, so
several dev servers can run side by side. `npm run tauri dev` deliberately does **not** slide: it
pins 1421 (matching `build.devUrl` in `tauri.conf.json`, a static address) via `vite --strictPort`,
so a busy port fails loudly instead of opening a window against a dead address. 1421 rather than
1420 lets the desktop app run next to an already-open browser dev server; real-device HMR uses 1422.

All logic that can be pure JS lives in plain modules under `src/` and is covered by vitest.
Components (`src/*.vue`, `src/tools/*.vue`) stay thin; when a behavior is non-trivial, put it in
a testable module instead of a component.

## Before opening a PR

- `npm test` passes, and `cargo check` passes if you touched `src-tauri/`.
- Keep the two locales in sync: `src/i18n/zh-CN.json` and `src/i18n/en-US.json` must have
  identical key sets (`src/i18n/i18n.test.js` enforces this).
- Follow the existing commit style (`feat: …`, `fix: …`, `docs: …`), one logical change per commit.
- Add or update tests for behavior changes. Bug fixes should come with a regression test.
- **A new tool must also be an action.** The toolbox is the agent's action space, so a new tool
  ships with an entry in `src/agent/catalog.js` (name, description, argument schema, risk tier) and
  a wired executor — or says explicitly in the PR why a human has to be the one doing it
  (Screenshot, Rail Tycoon and Interview prep are the accepted exceptions; see
  "What the agent can drive — and what it cannot" in README). `catalog.test.js` fails if the catalog
  and the implementation drift apart in either direction, and `toolboxTools.js` is the single
  registry the gallery and global search render from — document the tool there, not in three places.
- Don't add dependencies unless they clearly earn their place; the project deliberately avoids a
  router, a state library, and a UI framework.

## Architecture notes

- `src/agent/` — the agent engine: a pure tool-calling loop (`runtime.js`), the tool **catalog**
  (`catalog.js`, metadata only so it can be read at startup without dragging in 300KB of tool
  implementations), the approval policy and risk tiers (`approval.js`), result budgeting and spill
  handles (`resultBudget.js`, `spillStore.js`), run records for resume (`runStore.js`), the skill
  library (`skills.js` / `skillStore.js`) and the assembly layer (`index.js`).
- `src/toolboxTools.js` — the single tool registry: gallery, group layout, global search and the
  desktop-only filtering all read it. Add a tool here and document it here, not in scattered lists.
- `src/sync/` — end-to-end encrypted sync engine (client) plus `server/` (zero-dependency Node
  server that only ever stores ciphertext).
- `src/tools/` — toolbox tool components; each tool's logic lives in a matching plain-JS module.
- `src-tauri/src/` — Rust commands: storage, files, network proxy, database drivers, AI streaming,
  secure storage, notifications, updater.

## Security and privacy red lines

- Never commit keys or credentials: `src-tauri/updater.key` (update signing) and any deployment
  secrets are gitignored and must stay that way.
- Do not commit real server addresses, personal data, or captured production traffic. Use
  `example.com` placeholders in docs, tests, and screenshots.
- User data stays local: no analytics, no telemetry uploads, no hidden network calls. Any new
  outbound request must be explicit, user-configured, and documented.

## Reporting bugs / requesting features

Use the GitHub issue templates. For security issues, please follow [SECURITY.md](SECURITY.md)
instead of opening a public issue.
