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
- **UI changes follow [`docs/ui-ux-spec.md`](docs/ui-ux-spec.md).** Tokens live in
  `src/styles/tokens.css`, component styles in `src/styles/primitives.css` (the only place a
  component family may be defined), and `src/styles/uiSpec.test.js` enforces it: some rules are hard
  zeros, the rest are ratcheted against `src/styles/uiDebtBaseline.json` — you may lower a number,
  never raise it. Run `npx vitest run src/styles/` before pushing a style change.
  If you change a token's value in `tokens.css`, also run `npm run gen:ui-scale` — the scale table
  in §2.1 of the spec is generated from the tokens, and a stale one fails the suite by design.
  Mobile is a separate layer (`mobile/app/styles/shell.css`, it does not import `primitives.css`),
  so a mobile button family that can be `:disabled` needs its own disabled affordance there.
  Paste the checklist in §13 of the spec into the PR description and tick it line by line.
  If you need to extend the spec itself (new token, new component family, new metric),
  follow §14 — in particular never hand-edit `src/styles/uiDebtBaseline.json`.
- Keep the two locales in sync: `src/i18n/zh-CN.json` and `src/i18n/en-US.json` must have
  identical key sets (`src/i18n/i18n.test.js` enforces this).
- Follow the existing commit style (`feat: …`, `fix: …`, `docs: …`), one logical change per commit.
- Add or update tests for behavior changes. Bug fixes should come with a regression test.
- **A new tool must also be an action.** The toolbox is the agent's action space, so a new tool is
  a self-contained package under `src/tools/<key>/`: `contract.js` (pure data — UI metadata: gallery
  label, icon, group, search keywords, `order`; plus agent actions: name, description, argument
  schema, risk tier), an optional `logic.js` (pure logic shared by the tool's view and its agent
  executor), an optional `executor.js` (the actions' implementations) and `View.vue`. Registration
  is **generated, not hand-written**: run `npm run gen:tools` and the contract aggregate
  (`src/contracts/index.generated.js`), the component loaders and the action table are rebuilt from
  the directory tree. That is what lets two people add two different tools on two branches without
  fighting over a shared registration file. The tool's own **i18n entries live inside its package**
  too — `src/tools/<key>/i18n.<locale>.json` (a nested fragment covering only that tool's subtree)
  — and `gen:i18n` (`npm run gen:tools` runs it as well) merges every package's fragment into
  `src/i18n/tools.generated.js`, so adding a tool no longer means editing the shared dictionaries.
  `i18nFragments.test.js` enforces the two locales' key parity, single source of truth, and that
  the merged key set stays identical to the pre-migration snapshot. If a human has to be the one
  doing it, say so in the
  contract's `agentExempt` field instead (Screenshot, Rail Tycoon and Interview prep are the
  accepted exceptions; see "What the agent can drive — and what it cannot" in README).
  `contracts.test.js` enforces the admission rule (actions or a written exemption),
  `registryGating.test.js` fails when you forget to re-run the generator, and `catalog.test.js`
  fails if the catalog and the implementation drift apart in either direction.
- Don't add dependencies unless they clearly earn their place; the project deliberately avoids a
  router, a state library, and a UI framework.

## Architecture notes

- `src/agent/` — the agent engine: a pure tool-calling loop (`runtime.js`), the tool **catalog**
  (`catalog.js`, a projection of the contracts plus engine/business actions; metadata only so it
  can be read at startup without dragging in 300KB of tool
  implementations), the approval policy and risk tiers (`approval.js`), result budgeting and spill
  handles (`resultBudget.js`, `spillStore.js`), run records for resume (`runStore.js`), the skill
  library (`skills.js` / `skillStore.js`) and the assembly layer (`index.js`).
- `src/tools/<key>/` — one **package per tool** (think of it as a skill or an MCP server):
  `contract.js` (pure data: toolbox UI metadata + agent actions, or an `agentExempt` reason),
  optional `logic.js` (pure logic the view and the agent executor share), optional `executor.js`
  (action implementations, heavy deps imported only at execution time), `View.vue` and the tool's
  own tests. Registration is directory-driven: `scripts/gen-tool-registry.mjs` scans
  `src/tools/*/contract.js` and writes three **static-import** artifacts. Static imports (not
  `import.meta.glob`) are required because contracts must also load under plain Node ESM — the
  mobile parity tests import them by real path. A module stays in the neutral root layer (e.g.
  `json.js`, `textDiff.js`, `nativeInvoke.js`) whenever something outside its package needs it.
- `src/contracts/` — the generated registry plus the shared contract infrastructure: `kit.js`
  (schema helpers), `groups.js` (gallery groups), `index.js` (stable façade) and
  `index.generated.js`. `src/toolboxTools.js` projects the `ui` field for gallery, group layout,
  global search and platform/edition filtering — add a tool package, not a scattered list entry.
- `src/sync/` — end-to-end encrypted sync engine (client) plus `server/` (zero-dependency Node
  server that only ever stores ciphertext).
- `src/tools/` — see the per-tool package layout above; each tool owns its view, logic, executor
  and tests.
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
