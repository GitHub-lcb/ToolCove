# ToolCove · 工具湾

**An agent-driven developer workbench — local-first, no account, free and open source (MIT).**

ToolCove gathers the small but frequent actions of daily development — formatting, conversion,
encryption, diffing, request debugging, quick notes, issue tracking, and AI assistance — into one
app, with a built-in agent that can drive those tools for you. It runs as a **Windows desktop app**
(Tauri 2) and as a **static web app** in the browser.

![ToolCove](docs/screenshots/toolbox-dark.png)

## Features

- **Agent workspace** — the default first screen. Describe a goal in natural language; the agent
  plans, calls tools (including file, database, and network tools on the desktop build), shows
  every step live, and asks for confirmation before risky writes. Bring your own OpenAI-compatible
  endpoint; a run log is kept so an interrupted task can be resumed.
- **Toolbox** — 15 built-in tools, each opens in its own draggable/resizable window (the title-bar pin
  keeps a window above all others, so a HUD-style tool can float over a game in borderless mode):

  | Group | Tools |
  |-------|-------|
  | Data & Text | Data conversion (Base64 / URL / Unicode / Hex / JWT / JSON escape), Text processing (diff / regex / replace / line ops / naming / stats), Time & schedule (timestamp / timezone / Cron), Structured data (JSON / YAML validate-format-tree-convert), Data generation (UUID / ULID / NanoID / mock / templates) |
  | Network & API | Network diagnostics (URL / CIDR / DNS / port / ping / route), API debugger (collections & environments) |
  | File & Media | File processing (info / encoding / Base64 / line endings / batch rename), Image processing (convert / compress / resize / colors / icon generator / EXIF), PDF toolkit (merge / split by range / extract or delete pages / rotate / decrypt), Label printing (TSPL layout, barcode/QR, live 203dpi preview, .prn export) |
  | Dev tools | Crypto & checksum (digest / HMAC / AES / RSA / password generator), Database manager (connect, run SQL, browse tables) |
  | AI | AI chat (multi-session, image input, prompt presets) |
  | Game helpers | Rail Tycoon route solver (Lord of the Mysteries homestead trade run: enumerates every valid stop layout from the "next 3 stops" hints, locks the next stop and advises which card to take) |

  Network diagnostics, file processing, the database manager and label printing need native capabilities
  and are available in the desktop build only; everything else — including the PDF toolkit, which runs in
  the frontend on pdf-lib (plus qpdf-wasm, lazily fetched only when a file turns out to be
  encrypted) — works in both builds.

  The gallery home has its own search (tool name, capability, or keyword), a quick-access row built
  from your pinned and recently used tools, and collapsible groups whose tools render as two-column
  cards on wide windows. Pinned tools and expanded groups are remembered locally.

  Homestead trade run: it treats each stop's "next 3 stops" hint as a constraint, enumerates every
  valid layout, marks the stops that are uniquely determined, and turns the inference into card
  advice. It ships a "Cockpit" HUD layout (oversized next-stop verdict plus one-tap recording for the
  current stop) and a "Full layout" table, and the window can be pinned above everything else to sit
  over the game. Everything runs locally — no network, no injection, no game-process access — and it
  works in both the desktop and browser builds.

- **Snippets** — quick notes with one-click copy, global search, password masking, and image attachments.
- **Problems** — lightweight issue tracker with local tags, AI-assisted analysis, and team-experience reuse.
- **Cloud sync (optional)** — end-to-end encrypted multi-device sync for snippets and issues.
  The server only ever stores ciphertext; pairing uses anonymous codes, no account. Self-host with
  the zero-dependency Node server in [`server/`](server/README.md) or use a hosted instance you trust.

**Privacy first**: everything is stored locally — JSON files in your app-data directory on the
desktop build, IndexedDB in the browser. No account, no telemetry uploads, no cloud sync unless you
turn it on. Outbound traffic is only what you explicitly trigger: AI requests, HTTP debugging, and
optional sync.

## Browser build

The same app builds as a static site — no backend required:

```bash
npm i && npm run build:web   # outputs dist/, deploy anywhere (GitHub Pages, Vercel, Netlify…)
```

In the browser, data lives in IndexedDB and desktop-only capabilities (database drivers, file-system
tools, autostart, in-app updater, OS keychain, cloud sync) are hidden rather than shown broken —
settings, the tool gallery and the agent's tool list all adapt to the platform, and tools that would
open in their own window open inline instead. AI and the agent work with any CORS-enabled
OpenAI-compatible endpoint.

## Download & Update

- Download the latest Windows installer from [GitHub Releases](https://github.com/GitHub-lcb/ToolCove/releases).
- The app checks for updates on startup and on demand (Settings → Check for updates).
  Updates are signed and verified against the built-in public key before installation.
- The Oracle JDBC driver used by the database tool is distributed separately
  ([tag: drivers](https://github.com/GitHub-lcb/ToolCove/releases/tag/drivers)) and downloaded
  on first use of the database tool.

> Note: downloads from GitHub Releases can be slow in mainland China; a mirror may be provided later.

## Sponsor

ToolCove is free, with no paid tiers and nothing held back for a "Pro" plan. If it saves you time,
you can support development (server, code-signing and store costs) — sponsorship never unlocks
features:

- [爱发电 / Afdian](https://afdian.com/a/toolcove)
- A ⭐ on GitHub also helps a lot.

## Build from source

Requires Node.js ≥ 20 and Rust (MSVC toolchain) for the desktop shell.

```bash
npm install
npm run tauri dev     # run the desktop app with hot reload
npm run test          # unit tests (vitest)
npm run test:e2e      # end-to-end (Playwright against the web build; needs Chrome)
npm run build         # frontend build (desktop bundle)
npm run build:web     # static web build
cd src-tauri && cargo check   # Rust checks
```

E2E runs on the static web build and covers what unit tests cannot: the write-preview diff on the
approval card, the question card taking a **text** answer, and a denied write producing no write at
all. It uses the system Chrome (no browser download) and stubs the desktop IPC boundary so the
desktop-only file tools are exercised too — see `e2e/helpers.js` for why that is trustworthy.
Set `E2E_CHANNEL=chromium` to run on Playwright's own browser instead.

### Release

Releases are built by the [`Release`](.github/workflows/release.yml) workflow: bump the version in
`package.json` and `src-tauri/tauri.conf.json` (they must match), push `main`, then push a `v<version>`
tag. CI signs the installer on `windows-latest`, uploads the bundles plus the updater `latest.json`,
and opens a **draft** release — review the artifacts and hit *Publish release* to ship (the in-app
updater only sees published releases). Re-runs are available from the Actions tab
(`workflow_dispatch`).

### Mobile app

The Android app is being rebuilt from scratch to reach feature parity with the desktop build —
see [`docs/mobile-app-plan.md`](docs/mobile-app-plan.md) for the architecture, phasing and the
platform limits that cannot be matched (JDBC, raw label printing, ICMP/DNS diagnostics).
The previous phone build (a rail-tycoon floating panel) has been removed; the Rail Tycoon tool
itself stays: its solver lives in `src/tools/railTycoon.js` and is used by the desktop and browser
builds, and it will return to the app as one of its tools.

One-time setup — repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | full contents of `src-tauri/updater.key` (348-char base64 single line) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | private-key password; leave empty/unset for a password-less key |

> The signing key can forge update packages, so it lives only in that secret and never in the repo
> (see the red-line note in `.gitignore`).

Recommended hardening — create an environment named `release` (Settings → Environments) with
**Required reviewers**, and add yourself to the list. The release job declares that environment, so
every release then waits for your approval before the key is ever decrypted. Without protection
rules the declaration is inert. All third-party actions are pinned to full commit SHAs for the same
reason: a floating tag can be re-pointed at malicious code that would run next to the signing key.

#### Rotating the update signing key

```bash
npx tauri signer generate -w src-tauri/updater.key.new   # prints the new public key file
# 1) copy updater.key.new.pub verbatim into plugins.updater.pubkey in src-tauri/tauri.conf.json
# 2) replace src-tauri/updater.key with updater.key.new and paste the new secret into GitHub
```

Both halves must be swapped **together**: signing with a key the app does not trust makes every
update fail verification (Tauri fails closed, so users see a failed update rather than a bad
install). Note the one unavoidable cost — installs carrying the *old* public key cannot auto-update
across a rotation, so that release has to be downloaded and installed manually once; from then on
automatic updates resume. Rotate early rather than late for exactly this reason.

Fully local fallback, if you would rather keep the key off GitHub entirely:

```bash
npm run release -- "release notes"   # build, sign, create GitHub Release, upload assets
node scripts/release.js --drivers     # upload oracle-driver.zip to the `drivers` tag (once)
```

> Note: use `node scripts/release.js` directly for flag-style arguments (`--drivers`);
> `npm run release -- --drivers` would swallow the flag as an npm config.

Requires a `GITHUB_TOKEN` environment variable (PAT with `repo` scope). This path also tags the
commit that GitHub reports for `main`, so push first. Do not run it and the workflow for the same
version — both write to the same release.

## Tech stack

Tauri 2 · Vue 3 · Vite · vitest · vue-i18n. No router / state library / UI framework — plain
components, CSS variables for theming, business logic in pure JS modules covered by unit tests.

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). For security reports, use
[SECURITY.md](SECURITY.md) instead of a public issue.

## License

[MIT](LICENSE) © GitHub-lcb

---

## 中文简介

ToolCove（工具湾）是面向开发者的效率工作台，把日常高频的零散开发动作收拢到一个应用里，
内置 Agent 智能体帮你串联这些工具。支持 **Windows 桌面端**（Tauri 2）与**浏览器端**（纯静态站点）。

- **Agent 工作台**：默认首屏。用自然语言描述目标，Agent 规划并调用工具（桌面端含文件、数据库、
  网络等能力），过程实时可见，写入类操作先确认后执行；支持中断续跑与运行记录。
- **工具箱**：15 个内置工具——数据转换、文本处理、时间调度、结构化数据、数据生成、网络诊断、
  API 调试、文件处理、图片处理、PDF 工具、标签打印、加密与校验、数据库管理、AI 对话、铁路大亨站点推断，每个工具独立窗口，即开即用。
  其中网络诊断、文件处理、数据库管理、标签打印依赖原生能力，仅桌面端提供，浏览器端自动隐藏；
  PDF 工具（合并 / 拆分 / 提取删除页 / 旋转 / 去加密）纯前端实现：常规操作走 pdf-lib，
  遇到加密文件时才按需拉取 qpdf-wasm 去除加密（电子发票、银行回单这类权限加密无需密码）。
  标签打印面向佳博 GP-2120TF 这类 TSPL 热敏标签机：排版算成绝对坐标后直接生成 `TEXT` / `BARCODE` /
  `QRCODE` 指令，按 GB18030 编码走 RAW 写入 Windows 打印队列（不经驱动渲染，203dpi 下最锐利），
  预览与实打同源，可导出 `.prn` 给供应商排查。
  首页支持按名称 / 能力 / 关键词检索，顶部「常用工具」按收藏与最近使用排列，分类可同时展开、
  宽窗口下工具卡两列排布；收藏与展开状态本地记忆。
  铁路大亨站点推断（游戏辅助）面向《诡秘之主》家园「列车贸易」的挑战线路：把每站的「未来 3 站」
  提示当作约束，穷举全部合法排列后标出能被唯一确定的站点，并按推断结果给策略卡建议；
  提供「驾驶舱」HUD 版面（巨型下一站结论 + 当前站一键录入）与「完整版面」全表，窗口可置顶，
  配合游戏的无边框窗口模式就能浮在画面上；全程纯本地计算，不联网、不注入、不读取游戏进程。
- **手机端**：安卓 App 正在重做，目标是**功能对齐桌面端**——架构、分期与无法对齐的平台能力
  （JDBC、真打印、ICMP/DNS 诊断）见 [`docs/mobile-app-plan.md`](docs/mobile-app-plan.md)。
  旧的手机端实现（铁路大亨悬浮面板）已整体移除；铁路大亨的求解逻辑仍在
  `src/tools/railTycoon.js`，桌面端与浏览器端照常使用，后续会作为 App 里的一个工具回归。
- **速记**：常用数据随手记，一键复制、全局搜索（Ctrl+K）、密码脱敏、图片附件。
- **问题记录**：轻量问题跟踪，本地标签分类，支持 AI 辅助分析与经验复用。
- **云同步（可选）**：速记与问题记录的多设备端到端加密同步；服务端只见密文，配对码入伙、
  无需账号，可用 `server/` 内的零依赖 Node 服务自托管。

**纯本地、无账号、开源免费（MIT）**：数据全部保存在本机（桌面端为本地 JSON，浏览器端为
IndexedDB）；无遥测上传、无强制云同步；外部请求（AI、HTTP 调试、可选同步）均由你主动触发。

- 下载安装：[GitHub Releases](https://github.com/GitHub-lcb/ToolCove/releases)（应用启动时自动检查更新，
  更新包验签后安装）
- 浏览器端：`npm run build:web` 产出 `dist/`，可直接部署到任意静态托管；数据存 IndexedDB，
  桌面独占能力（本地文件、数据库、云同步、自动更新等）自动隐藏
- 反馈与共建：[Issues](https://github.com/GitHub-lcb/ToolCove/issues) · [CONTRIBUTING.md](CONTRIBUTING.md)
