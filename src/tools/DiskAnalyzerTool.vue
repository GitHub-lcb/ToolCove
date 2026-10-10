<script setup>
// 磁盘分析助手（tool-disk 窗口）：磁盘/目录扫描 → 体积聚合 → 下钻 → 清理（删除到回收站）。
//
// 分工与约束（与 Rust 侧 disk.rs 的注释对应）：
//  - 扫描是异步长任务：start 立即返回，进度与结果都走 `disk:progress` 事件；
//    取消后 Rust 侧丢弃整棵树，这里回落到空态。
//  - 目录树留在 Rust 内存里，下钻只取「当前节点的一页子目录」（disk_scan_children）；
//    文件列表按当前目录实时读盘（disk_dir_files）——单个目录毫秒级，不进快照。
//  - 删除**只走系统回收站**（disk_delete_to_trash，可恢复）。永久删除没有「误点」的退路，
//    本工具不提供——这是有意为之，不是没做完。
//  - 删除后体积是「就地扣减」而不是重算：目录体积来自扫描快照，单项重算要重扫子树。
//    因此删完会打上「重新扫描可完全刷新」的标记，如实说明数据口径。
//  - 会话在窗口关闭前显式释放（disk_scan_release），否则整棵树的内存挂到进程退出。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../platform/invoke.js";
import { listen } from "../platform/events.js";
import { open as openDialog } from "../platform/dialog.js";
import { openPath, revealPath } from "../platform/shell.js";
import { askConfirm } from "../confirm.js";
import { loadToolbox, saveToolbox } from "../toolboxStore.js";
import Icon from "../Icon.vue";
import {
  applyDeletions,
  durationParts,
  formatBytes,
  formatPercent,
  isDirectChild,
  mergeEntries,
  selectionTotals,
  share,
  squarify,
  tileAt,
} from "../diskAnalyzer.js";

const props = defineProps({ showToast: { type: Function, default: () => {} } });
const { t } = useI18n();
const toast = (message, options) => props.showToast(message, options);

/** 「显示更多」每次放开的文件行数（首个列表上限也是它；Rust 侧硬上限 5000，见 DISK_DIR_FILES_MAX）。 */
const FILES_PAGE = 500;
const FILES_LIMIT_MAX = 5000;
/** 一次删除的项数上限（与 Rust 侧 DISK_DELETE_MAX_ITEMS 对齐）：超了在确认前就挡住，别让用户白点一次。 */
const MAX_DELETE_ITEMS = 500;

const drives = ref([]);
const loadError = ref("");
const scanning = ref(false);
const sessionId = ref("");
const progress = ref({ entries: 0, bytes: 0, dirs: 0, errors: 0, path: "" });
const summary = ref(null);
const topFiles = ref([]);
const navStack = ref([]);
const currentDirs = ref([]);
const currentFiles = ref([]);
const currentLinks = ref([]); // 当前目录里的链接（junction / 符号链接）：不计数、打标签、不给删除/迁移
const filesLimit = ref(FILES_PAGE);
const childMeta = ref({ childCount: 0, truncated: false });
const filesMeta = ref({ fileCount: 0, totalBytes: 0, truncated: false });
const loadingNode = ref(false);
const hover = ref(null);
const treemapRef = ref(null);
const tiles = ref([]);
const selected = ref(new Map()); // path -> { kind, path, name, size, files, dirs }
const deleting = ref(false);
const staleNotice = ref(false); // 删除后就地扣减过体积：汇总处如实标注

// 迁移（搬到别的盘 + 原地留 junction）
const migratePlan = ref(null); // 迁移对话框：{ source, name, targetParent, check, busy, error }
const migrateRun = ref(null); // 迁移进度/结果：{ kind, phase, copiedBytes, totalBytes, files, totalFiles, current, error, canceling }
const migrateSession = ref("");
const records = ref([]); // 迁移记录（可回滚）
const showRecords = ref(false);
const rootInfo = ref(null); // 扫描根是链接 / 在链接内：顶部警示（真机踩过：扫链接看到的是目标盘的内容）

const activeRoot = computed(() => summary.value?.root || "");
const activeNode = computed(() => navStack.value[navStack.value.length - 1] || null);
const rows = computed(() => mergeEntries(currentDirs.value, currentFiles.value, filesLimit.value + currentDirs.value.length));
/** 还没装进列表的文件数（「显示更多」按钮上的数字）。 */
const hiddenFiles = computed(() => Math.max(0, (Number(filesMeta.value.fileCount) || 0) - currentFiles.value.length));
const treemapDirs = computed(() => currentDirs.value.filter((dir) => Number(dir.size) > 0));
const selection = computed(() => selectionTotals([...selected.value.values()]));

function newSessionId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `disk-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

function driveLetter(root) {
  const value = String(root || "");
  const drive = value.match(/^([A-Za-z]):/);
  if (drive) return `${drive[1]}:`;
  return value.replace(/[\\/]+$/, "") || value;
}

function fileName(path) {
  return String(path || "").split(/[\\/]/).pop() || String(path || "");
}

/** 面包屑根格：盘根显示盘符，扫的是文件夹时显示文件夹名（别一律显示成 "C:"）。 */
function rootLabel(path) {
  const value = String(path || "");
  if (/^[A-Za-z]:[\\/]?$/.test(value)) return driveLetter(value);
  return fileName(value.replace(/[\\/]+$/, "")) || value;
}

function joinPath(parent, name) {
  const base = String(parent || "");
  const separator = base.includes("\\") || /^[A-Za-z]:/.test(base) ? "\\" : "/";
  return base.endsWith("\\") || base.endsWith("/") ? `${base}${name}` : `${base}${separator}${name}`;
}

function percentWidth(part, whole) {
  return `${(share(part, whole) * 100).toFixed(2)}%`;
}

function durationText(ms) {
  const parts = durationParts(ms);
  const key = parts.unit === "ms" ? "elapsedMs" : parts.unit === "s" ? "elapsedS" : "elapsedMin";
  return `${parts.value} ${t(`toolbox.disk.${key}`)}`;
}

function isDarkTheme() {
  const mode = localStorage.getItem("themeMode") || "system";
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

// ---- 选择（路径 → 条目）：当前目录的行与「最大文件」榜单共用同一份选择 ----

function entryOfDir(dir) {
  return {
    kind: "dir",
    path: joinPath(activeNode.value?.path, dir.name),
    name: String(dir.name ?? ""),
    size: Number(dir.size) || 0,
    files: Number(dir.files) || 0,
    dirs: Number(dir.dirs) || 0,
  };
}

function entryOfFile(file) {
  return {
    kind: "file",
    path: String(file.path ?? ""),
    name: String(file.name ?? fileName(file.path)),
    size: Number(file.size) || 0,
    files: 0,
    dirs: 0,
  };
}

function isSelected(path) {
  return selected.value.has(path);
}

function toggleSelect(entry) {
  const next = new Map(selected.value);
  if (next.has(entry.path)) next.delete(entry.path);
  else next.set(entry.path, entry);
  selected.value = next;
}

function selectAllRows() {
  const next = new Map(selected.value);
  for (const dir of currentDirs.value) {
    const entry = entryOfDir(dir);
    next.set(entry.path, entry);
  }
  for (const file of currentFiles.value) {
    const entry = entryOfFile(file);
    next.set(entry.path, entry);
  }
  selected.value = next;
}

function clearSelection() {
  selected.value = new Map();
}

/** 选中项的路径清单（模板里 ref 已解包，取 keys 走这个函数，别在模板里写 selected.value）。 */
function selectedPaths() {
  return [...selected.value.keys()];
}

async function loadDrives() {
  try {
    const list = await invoke("disk_list_drives");
    drives.value = Array.isArray(list) ? list : [];
    loadError.value = "";
  } catch (error) {
    // 浏览器形态直达链接：如实说明是桌面版能力，而不是留一个点不动的界面
    loadError.value = String(error?.message || error);
  }
}

/**
 * 磁盘容量是「拉取那一刻」的快照，不是实时读数：迁移/重扫/窗口重新获得焦点后都要刷新。
 * 真机踩过：迁移完 C: 的可用空间没变，用户以为迁移失败了。
 */
let lastDriveRefresh = 0;
async function refreshDrivesThrottled() {
  const now = Date.now();
  if (now - lastDriveRefresh < 3000) return;
  lastDriveRefresh = now;
  await loadDrives();
}

/** 迁移前的容量快照：完成后算差值，把「C: +8 GB · E: −8 GB」写进成功提示。 */
function snapshotDrives() {
  return new Map(drives.value.map((drive) => [String(drive.root), Number(drive.free) || 0]));
}

/** 与快照相比的可用空间变化文案（1 MB 以下当噪声；没有变化就返回空串）。 */
function driveDeltaText(snapshot) {
  const parts = [];
  for (const drive of drives.value) {
    const before = snapshot.get(String(drive.root));
    if (before === undefined) continue;
    const delta = (Number(drive.free) || 0) - before;
    if (Math.abs(delta) < 1024 * 1024) continue;
    parts.push(`${driveLetter(drive.root)} ${delta > 0 ? "+" : "−"}${formatBytes(Math.abs(delta))}`);
  }
  return parts.length ? t("toolbox.disk.migrateSpace", { delta: parts.join(" · ") }) : "";
}

async function scan(root) {
  const target = String(root || "").trim();
  if (!target || scanning.value) return;
  if (sessionId.value) {
    try {
      await invoke("disk_scan_release", { sessionId: sessionId.value });
    } catch {
      // 释放失败不阻断新扫描：旧会话最终由 Rust 侧的配额与取消兜底
    }
  }
  const id = newSessionId();
  sessionId.value = id;
  summary.value = null;
  topFiles.value = [];
  navStack.value = [];
  currentDirs.value = [];
  currentFiles.value = [];
  currentLinks.value = [];
  tiles.value = [];
  selected.value = new Map();
  staleNotice.value = false;
  rootInfo.value = null;
  childMeta.value = { childCount: 0, truncated: false };
  progress.value = { entries: 0, bytes: 0, dirs: 0, errors: 0, path: target };
  scanning.value = true;
  resolveRoot(target); // 并行探测：扫描根是不是链接（拿不到就只是不提示）
  try {
    await invoke("disk_scan_start", { sessionId: id, root: target });
  } catch (error) {
    scanning.value = false;
    sessionId.value = "";
    toast(String(error?.message || error));
  }
}

async function cancelScan() {
  if (!sessionId.value) return;
  try {
    await invoke("disk_scan_cancel", { sessionId: sessionId.value });
  } catch (error) {
    toast(String(error?.message || error));
  }
}

async function pickFolder() {
  const picked = await openDialog({ directory: true, multiple: false, title: t("toolbox.disk.pickFolder") });
  const path = typeof picked === "string" ? picked : Array.isArray(picked) ? picked[0] : "";
  if (path) await scan(path);
}

async function onProgress(event) {
  const payload = event?.payload;
  if (!payload || payload.sessionId !== sessionId.value) return;
  if (payload.status === "running") {
    progress.value = {
      entries: Number(payload.entries) || 0,
      bytes: Number(payload.bytes) || 0,
      dirs: Number(payload.dirs) || 0,
      errors: Number(payload.errors) || 0,
      path: String(payload.path || ""),
    };
    return;
  }
  scanning.value = false;
  if (payload.status === "canceled") {
    sessionId.value = "";
    toast(t("toolbox.disk.canceledToast"));
    return;
  }
  if (payload.status === "done") {
    summary.value = payload.summary || null;
    topFiles.value = Array.isArray(payload.topFiles) ? payload.topFiles : [];
    await loadNode(0, { reset: true });
    // 扫描顺带把磁盘容量也刷新一遍：重扫的语义就是「重新量一遍现状」
    lastDriveRefresh = Date.now();
    await loadDrives();
  }
}

async function loadNode(nodeId, { reset = false, push = false, truncateTo = null } = {}) {
  if (!sessionId.value) return;
  loadingNode.value = true;
  try {
    const page = await invoke("disk_scan_children", { sessionId: sessionId.value, nodeId });
    const node = page?.node;
    if (!node) return;
    if (reset) navStack.value = [node];
    else if (push) navStack.value = [...navStack.value, node];
    else if (truncateTo !== null) navStack.value = navStack.value.slice(0, truncateTo + 1);
    currentDirs.value = Array.isArray(page?.children) ? page.children : [];
    currentLinks.value = Array.isArray(page?.links) ? page.links : [];
    childMeta.value = { childCount: Number(page?.childCount) || 0, truncated: Boolean(page?.truncated) };
    hover.value = null;
    // 换目录即清空选择：上一层的选中项留着会变成「看不见但会被删掉的」清单
    selected.value = new Map();
    filesLimit.value = FILES_PAGE;
    await loadFiles(node.path || "");
  } catch (error) {
    toast(String(error?.message || error));
  } finally {
    loadingNode.value = false;
  }
}

async function loadFiles(path, limit = filesLimit.value) {
  currentFiles.value = [];
  filesMeta.value = { fileCount: 0, totalBytes: 0, truncated: false };
  if (!path) return;
  try {
    const result = await invoke("disk_dir_files", { path, limit: Math.min(limit, FILES_LIMIT_MAX) });
    currentFiles.value = Array.isArray(result?.files) ? result.files : [];
    filesMeta.value = {
      fileCount: Number(result?.fileCount) || 0,
      totalBytes: Number(result?.totalBytes) || 0,
      truncated: Boolean(result?.truncated),
    };
  } catch {
    // 目录在扫描后被删除/改名：文件列表面板留空即可，不当作错误打扰用户
  }
}

/** 「显示更多」：把文件列表上限放开一页再重读（真数不变，只是装进列表的更多）。 */
async function showMoreFiles() {
  if (!activeNode.value || loadingNode.value) return;
  filesLimit.value = Math.min(FILES_LIMIT_MAX, filesLimit.value + FILES_PAGE);
  await loadFiles(activeNode.value.path || "");
}

/**
 * 判定扫描根是不是链接（或位于链接目录内）：真机踩过——用户扫已被迁移成 junction 的
 * `C:\...\Downloads`，看到的是 E: 上的真身内容，以为「C 盘里还有这些」，进而想再迁一次。
 */
async function resolveRoot(path) {
  try {
    const info = await invoke("disk_resolve_path", { path });
    rootInfo.value = info && (info.isLink || info.crossDrive) ? info : null;
  } catch {
    rootInfo.value = null; // 只是提示信息，拿不到就不提示
  }
}

/** 链接行点击：打开它的目标（读不到目标就退回原路径的位置）。 */
function linkOpenPath(link) {
  return String(link?.target || "") || joinPath(activeNode.value?.path, link?.name);
}

function drill(nodeId) {
  const id = Number(nodeId);
  if (!Number.isFinite(id) || loadingNode.value) return;
  loadNode(id, { push: true });
}

function goUp() {
  if (navStack.value.length <= 1 || loadingNode.value) return;
  const index = navStack.value.length - 2;
  loadNode(navStack.value[index].id, { truncateTo: index });
}

async function openEntry(path) {
  if (!path) return;
  try {
    await openPath(path);
  } catch (error) {
    toast(String(error?.message || error));
  }
}

async function reveal(path) {
  if (!path) return;
  try {
    await revealPath(path);
  } catch (error) {
    toast(String(error?.message || error));
  }
}

async function copyPaths(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) return;
  try {
    await navigator.clipboard.writeText(list.join("\n"));
    toast(list.length > 1 ? t("toolbox.disk.copiedManyToast", { n: list.length }) : t("toolbox.disk.copiedToast"));
  } catch (error) {
    toast(String(error?.message || error));
  }
}

// ---- 删除到回收站 ----

async function deleteEntries(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry?.path);
  if (!list.length || deleting.value || busyHeavy.value) return;
  if (list.length > MAX_DELETE_ITEMS) {
    toast(t("toolbox.disk.deleteTooMany", { max: MAX_DELETE_ITEMS }));
    return;
  }
  const totals = selectionTotals(list);
  const confirmed = await askConfirm({
    title: t("toolbox.disk.deleteTitle"),
    message: t("toolbox.disk.deleteMsg", { n: totals.count, size: formatBytes(totals.size) }),
    okText: t("toolbox.disk.deleteOk"),
  });
  if (!confirmed) return;

  deleting.value = true;
  try {
    const results = await invoke("disk_delete_to_trash", { paths: list.map((entry) => entry.path) });
    applyDeleteResults(list, Array.isArray(results) ? results : []);
  } catch (error) {
    toast(String(error?.message || error));
  } finally {
    deleting.value = false;
  }
}

function applyDeleteResults(entries, results) {
  const okPaths = new Set(results.filter((item) => item?.ok).map((item) => String(item.path)));
  const failed = results.filter((item) => !item?.ok);
  const removed = entries.filter((entry) => okPaths.has(entry.path));

  if (removed.length) {
    // 只有「当前目录的直接子项」的体积清清楚楚记在导航栈的节点上，可以就地扣减；
    // 从最大文件榜单里删别处的文件时，中间层目录的体积扣不动——那种情况只提示重新扫描。
    const node = activeNode.value;
    const inPlace = node ? removed.filter((entry) => isDirectChild(node.path, entry.path)) : [];
    if (inPlace.length) {
      navStack.value = applyDeletions(
        navStack.value,
        inPlace.map((entry) => ({ kind: entry.kind, size: entry.size, files: entry.files, dirs: entry.dirs }))
      );
      // 汇总条与目录栈同口径：只扣「能算清的那部分」，其余交给重新扫描（免得界面自相矛盾）
      if (summary.value) {
        const [deducted] = applyDeletions(
          [{ size: summary.value.totalBytes, files: summary.value.files, dirs: summary.value.dirs }],
          inPlace.map((entry) => ({ kind: entry.kind, size: entry.size, files: entry.files, dirs: entry.dirs }))
        );
        summary.value = { ...summary.value, totalBytes: deducted.size, files: deducted.files, dirs: deducted.dirs };
      }
    }
    const removedDirs = new Set(inPlace.filter((entry) => entry.kind === "dir").map((entry) => entry.path));
    if (removedDirs.size) {
      currentDirs.value = currentDirs.value.filter((dir) => !removedDirs.has(joinPath(node?.path, dir.name)));
      childMeta.value = { ...childMeta.value, childCount: Math.max(0, childMeta.value.childCount - removedDirs.size) };
    }
    const removedFiles = new Set(inPlace.filter((entry) => entry.kind === "file").map((entry) => entry.path));
    if (removedFiles.size) {
      const dropped = currentFiles.value.filter((file) => removedFiles.has(file.path));
      currentFiles.value = currentFiles.value.filter((file) => !removedFiles.has(file.path));
      const droppedBytes = dropped.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
      filesMeta.value = {
        ...filesMeta.value,
        fileCount: Math.max(0, filesMeta.value.fileCount - dropped.length),
        totalBytes: Math.max(0, filesMeta.value.totalBytes - droppedBytes),
      };
    }
    // 最大文件榜单：删掉的就是榜单上的条目
    topFiles.value = topFiles.value.filter((file) => !okPaths.has(String(file.path)));
    const remaining = new Map(selected.value);
    for (const entry of removed) remaining.delete(entry.path);
    selected.value = remaining;
    staleNotice.value = true;
    toast(t("toolbox.disk.deletedToast", { n: removed.length }), {
      actionLabel: t("toolbox.disk.rescan"),
      onAction: () => scan(activeRoot.value),
    });
  }
  if (failed.length) {
    toast(t("toolbox.disk.deleteFailedToast", { n: failed.length, error: String(failed[0]?.error || "") }));
  }
}

// ---- 迁移：搬到别的盘 + 原地留目录联接（junction），可回滚 ----

const MIGRATE_PHASE_KEYS = { copy: "migratePhaseCopy", switch: "migratePhaseSwitch", cleanup: "migratePhaseCleanup" };
/** 重活标记：扫描或迁移进行中时，删除/再扫描/迁移都要拦住——口径在变的时候动手最危险。 */
const busyHeavy = computed(() => scanning.value || Boolean(migrateRun.value));
const migratePercent = computed(() => {
  const run = migrateRun.value;
  if (!run) return 0;
  if (run.phase !== "copy") return 100;
  const total = Number(run.totalBytes) || 0;
  if (total <= 0) return 0;
  return Math.min(100, Math.round(((Number(run.copiedBytes) || 0) / total) * 100));
});
const migrateTargets = computed(() => {
  const sourceVolume = volumeKey(migratePlan.value?.source || "");
  return drives.value.filter((drive) => volumeKey(drive.root) !== sourceVolume);
});

/** 卷标识：与 Rust 侧同口径（Windows 取盘符，其它取根）。 */
function volumeKey(path) {
  const value = String(path || "");
  const drive = value.match(/^([A-Za-z]):/);
  if (drive) return drive[1].toLowerCase();
  return "/";
}

function defaultTarget(source) {
  const sourceVolume = volumeKey(source);
  const candidate = drives.value.find((drive) => volumeKey(drive.root) !== sourceVolume && Number(drive.total) > 0);
  return candidate ? candidate.root : "";
}

async function openMigrate(source, name) {
  if (busyHeavy.value || loadError.value) return;
  migratePlan.value = {
    source: String(source || ""),
    name: String(name || ""),
    targetParent: defaultTarget(source),
    check: null,
    busy: false,
    error: "",
    realInfo: null,
  };
  resolveMigrateLink(migratePlan.value.source);
  if (!migratePlan.value.targetParent) {
    migratePlan.value.error = t("toolbox.disk.migrateNoTarget");
    return;
  }
  await runMigrateCheck();
}

/** 迁移源是链接（或位于链接内）时在对话框里说清楚实体位置——别让用户在"假盘符"上做决策。 */
async function resolveMigrateLink(path) {
  const plan = migratePlan.value;
  if (!plan) return;
  try {
    const info = await invoke("disk_resolve_path", { path });
    if (migratePlan.value === plan && info && (info.isLink || info.crossDrive)) plan.realInfo = info;
  } catch {
    // 只是提示信息
  }
}

async function runMigrateCheck() {
  const plan = migratePlan.value;
  if (!plan?.targetParent) return;
  plan.busy = true;
  plan.error = "";
  plan.check = null;
  try {
    const check = await invoke("disk_migrate_check", { source: plan.source, targetParent: plan.targetParent });
    if (migratePlan.value === plan) plan.check = check;
  } catch (error) {
    if (migratePlan.value === plan) plan.error = String(error?.message || error);
  } finally {
    if (migratePlan.value === plan) plan.busy = false;
  }
}

async function pickMigrateTarget() {
  const plan = migratePlan.value;
  if (!plan) return;
  const picked = await openDialog({ directory: true, multiple: false, title: t("toolbox.disk.migratePickTarget") });
  const path = typeof picked === "string" ? picked : Array.isArray(picked) ? picked[0] : "";
  if (!path) return;
  plan.targetParent = path;
  await runMigrateCheck();
}

function closeMigratePlan() {
  migratePlan.value = null;
}

async function startMigrate() {
  const plan = migratePlan.value;
  if (!plan?.check) return;
  const confirmed = await askConfirm({
    title: t("toolbox.disk.migrateConfirmTitle"),
    message: t("toolbox.disk.migrateConfirmMsg", {
      name: plan.name,
      size: formatBytes(plan.check.bytes),
      target: plan.check.targetPath,
    }),
    okText: t("toolbox.disk.migrateStart"),
  });
  if (!confirmed) return;
  const id = newSessionId();
  migrateSession.value = id;
  migrateRun.value = {
    kind: "migrate",
    source: plan.source,
    targetParent: plan.targetParent,
    targetPath: plan.check.targetPath,
    phase: "copy",
    copiedBytes: 0,
    totalBytes: Number(plan.check.bytes) || 0,
    files: 0,
    totalFiles: Number(plan.check.files) || 0,
    current: "",
    error: "",
    canceling: false,
    driveSnapshot: snapshotDrives(),
  };
  migratePlan.value = null;
  try {
    await invoke("disk_migrate_start", { sessionId: id, source: plan.source, targetParent: plan.targetParent });
  } catch (error) {
    // start 的同步错误留在进度面板里显示，别让面板无声消失
    if (migrateRun.value) migrateRun.value.error = String(error?.message || error);
  }
}

async function startRollback(record) {
  if (!record || busyHeavy.value) return;
  const confirmed = await askConfirm({
    title: t("toolbox.disk.rollbackConfirmTitle"),
    message: t("toolbox.disk.rollbackConfirmMsg", { source: record.source, target: record.target }),
    okText: t("toolbox.disk.rollback"),
  });
  if (!confirmed) return;
  const id = newSessionId();
  migrateSession.value = id;
  migrateRun.value = {
    kind: "rollback",
    source: record.source,
    target: record.target,
    phase: "copy",
    copiedBytes: 0,
    totalBytes: Number(record.bytes) || 0,
    files: 0,
    totalFiles: Number(record.files) || 0,
    current: "",
    error: "",
    canceling: false,
    driveSnapshot: snapshotDrives(),
  };
  showRecords.value = false;
  try {
    await invoke("disk_migrate_rollback", { sessionId: id, source: record.source, target: record.target });
  } catch (error) {
    if (migrateRun.value) migrateRun.value.error = String(error?.message || error);
  }
}

async function cancelMigrate() {
  if (!migrateRun.value || migrateRun.value.error || !migrateSession.value) return;
  migrateRun.value.canceling = true;
  try {
    await invoke("disk_migrate_cancel", { sessionId: migrateSession.value });
  } catch (error) {
    toast(String(error?.message || error));
  }
}

function closeMigrateRun() {
  migrateRun.value = null;
  migrateSession.value = "";
}

/**
 * 失败后重试：迁移在复制阶段中止时**源目录一个字节都没动**（目标半成品已删），
 * 所以按同样参数再来一单是安全的；占用类失败（杀毒/索引/残留进程）往往几分钟后就放开了。
 */
async function retryMigrate() {
  const run = migrateRun.value;
  if (!run) return;
  if (run.kind === "rollback") {
    await startRollback({ source: run.source, target: run.target, bytes: run.totalBytes, files: run.totalFiles });
    return;
  }
  const confirmed = await askConfirm({
    title: t("toolbox.disk.migrateConfirmTitle"),
    message: t("toolbox.disk.migrateConfirmMsg", {
      name: fileName(run.source),
      size: formatBytes(run.totalBytes),
      target: run.targetPath || run.targetParent,
    }),
    okText: t("toolbox.disk.migrateRetry"),
  });
  if (!confirmed) return;
  const id = newSessionId();
  migrateSession.value = id;
  migrateRun.value = {
    ...run,
    phase: "copy",
    copiedBytes: 0,
    files: 0,
    current: "",
    error: "",
    canceling: false,
    driveSnapshot: snapshotDrives(),
  };
  try {
    await invoke("disk_migrate_start", { sessionId: id, source: run.source, targetParent: run.targetParent });
  } catch (error) {
    if (migrateRun.value) migrateRun.value.error = String(error?.message || error);
  }
}

async function onMigrateProgress(event) {
  const payload = event?.payload;
  if (!payload || payload.sessionId !== migrateSession.value) return;
  const run = migrateRun.value;
  if (!run) return;
  if (payload.status === "running") {
    run.phase = String(payload.phase || run.phase);
    run.copiedBytes = Number(payload.copiedBytes) || 0;
    run.totalBytes = Number(payload.totalBytes) || run.totalBytes;
    run.files = Number(payload.files) || 0;
    run.totalFiles = Number(payload.totalFiles) || run.totalFiles;
    run.current = String(payload.current || "");
    return;
  }
  if (payload.status === "done") {
    const report = payload.report || {};
    // 容量快照是迁移前拍的：刷完再看差值，把「C: +8 GB · E: −8 GB」写进提示——这是用户确认迁移生效的第一眼
    await loadDrives();
    lastDriveRefresh = Date.now();
    const space = run.driveSnapshot ? driveDeltaText(run.driveSnapshot) : "";
    if (run.kind === "rollback") {
      records.value = records.value.filter((record) => record.source !== report.source);
      persistRecords();
      toast(t("toolbox.disk.rollbackDone", { source: report.source || "", space }));
    } else {
      const leftovers = Number(report.leftovers) || 0;
      records.value = [
        {
          id: migrateSession.value,
          source: report.source,
          target: report.targetPath,
          bytes: Number(report.movedBytes) || 0,
          files: Number(report.movedFiles) || 0,
          at: Date.now(),
        },
        ...records.value,
      ].slice(0, 50);
      persistRecords();
      toast(
        leftovers
          ? t("toolbox.disk.migrateLeftovers", { n: leftovers, path: report.leftoverPaths?.[0] || "", space })
          : t("toolbox.disk.migrateDone", { target: String(report.targetPath || ""), space }),
        { actionLabel: t("toolbox.disk.rescan"), onAction: () => scan(activeRoot.value) }
      );
    }
    // 迁移后体积口径变了（数据在别的盘 / 链接不计入）：如实标注 + 给重扫入口
    staleNotice.value = true;
    closeMigrateRun();
    return;
  }
  if (payload.status === "canceled") {
    toast(t("toolbox.disk.migrateCanceled"));
    closeMigrateRun();
    return;
  }
  if (payload.status === "error") {
    run.error = String(payload.error || "");
    run.canceling = false;
  }
}

function persistRecords() {
  saveToolbox("disk-migrations", { records: records.value });
}

function forgetRecord(record) {
  records.value = records.value.filter((entry) => entry !== record);
  persistRecords();
}

// ---- treemap 绘制（Canvas + squarified 布局；布局算法在 diskAnalyzer.js 里单测） ----

let rafId = 0;
let resizeObserver = null;

function scheduleRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    renderTreemap();
  });
}

function renderTreemap() {
  const canvas = treemapRef.value;
  const wrap = canvas?.parentElement;
  if (!canvas || !wrap) return;
  const width = wrap.clientWidth;
  const height = wrap.clientHeight;
  if (width <= 2 || height <= 2) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const dirs = treemapDirs.value;
  const layout = squarify(dirs.map((dir) => ({ key: String(dir.id), size: dir.size })), { x: 0, y: 0, width, height });
  tiles.value = layout;
  if (!layout.length) return;

  const total = activeNode.value?.size || summary.value?.totalBytes || 0;
  const styles = getComputedStyle(document.documentElement);
  const borderColor = styles.getPropertyValue("--border-strong").trim() || "rgba(127,127,127,0.4)";
  const textColor = styles.getPropertyValue("--text").trim() || "#e6edf3";
  const fontFamily = getComputedStyle(document.body).fontFamily || "sans-serif";
  const dark = isDarkTheme();

  for (const tile of layout) {
    const dir = dirs.find((entry) => String(entry.id) === tile.key);
    if (!dir) continue;
    const ratio = share(dir.size, total);
    // 色相按节点 id 走（同一目录每次绘制颜色稳定）；明度随占比加深，最重的块最先跳进眼里
    const hue = (Number(dir.id) * 47 + 205) % 360;
    ctx.fillStyle = dark
      ? `hsl(${hue} 45% ${26 + Math.min(20, ratio * 90)}%)`
      : `hsl(${hue} 62% ${78 - Math.min(18, ratio * 40)}%)`;
    ctx.fillRect(tile.x, tile.y, tile.w, tile.h);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(tile.x + 0.5, tile.y + 0.5, Math.max(0, tile.w - 1), Math.max(0, tile.h - 1));
    if (tile.w < 68 || tile.h < 30) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(tile.x + 4, tile.y + 3, Math.max(0, tile.w - 8), Math.max(0, tile.h - 6));
    ctx.clip();
    ctx.textBaseline = "top";
    ctx.fillStyle = textColor;
    ctx.font = `600 12px ${fontFamily}`;
    ctx.fillText(dir.name, tile.x + 7, tile.y + 6, Math.max(10, tile.w - 14));
    if (tile.h >= 46) {
      ctx.globalAlpha = 0.72;
      ctx.font = `11px ${fontFamily}`;
      ctx.fillText(`${formatBytes(dir.size)} · ${formatPercent(dir.size, total)}`, tile.x + 7, tile.y + 23, Math.max(10, tile.w - 14));
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
}

function onCanvasMove(event) {
  const canvas = treemapRef.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const tile = tileAt(tiles.value, x, y);
  if (!tile) {
    hover.value = null;
    return;
  }
  const dir = currentDirs.value.find((entry) => String(entry.id) === tile.key);
  if (!dir) {
    hover.value = null;
    return;
  }
  const total = activeNode.value?.size || summary.value?.totalBytes || 0;
  hover.value = { x, y, name: dir.name, size: dir.size, percent: formatPercent(dir.size, total) };
}

function onCanvasLeave() {
  hover.value = null;
}

function onCanvasClick(event) {
  const canvas = treemapRef.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const tile = tileAt(tiles.value, event.clientX - rect.left, event.clientY - rect.top);
  if (tile) drill(tile.key);
}

const tipStyle = computed(() => {
  if (!hover.value) return {};
  return { left: `${Math.min(hover.value.x + 12, 320)}px`, top: `${hover.value.y + 12}px` };
});

watch([treemapDirs, activeNode], () => nextTick(scheduleRender));

// 画布在结果区（v-if）里，onMounted 时还不存在——必须盯 ref 本身：
// 它随「扫描完成」出现、随「重新扫描」消失，ResizeObserver 要跟着挂/摘。
watch(treemapRef, (canvas) => {
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = null;
  if (canvas?.parentElement) {
    resizeObserver = new ResizeObserver(() => scheduleRender());
    resizeObserver.observe(canvas.parentElement);
    scheduleRender();
  }
});

let unlistenProgress = null;
let unlistenMigrate = null;
let focusHandler = null;

onMounted(async () => {
  unlistenProgress = await listen("disk:progress", onProgress);
  unlistenMigrate = await listen("disk:migrate-progress", onMigrateProgress);
  // 窗口重新获得焦点时刷新容量：工具常开着，数字会被别的程序读写带漂
  focusHandler = () => refreshDrivesThrottled();
  window.addEventListener("focus", focusHandler);
  await loadDrives();
  const saved = await loadToolbox("disk-migrations", null);
  if (Array.isArray(saved?.records)) records.value = saved.records;
});

onBeforeUnmount(() => {
  if (unlistenProgress) unlistenProgress();
  unlistenProgress = null;
  if (unlistenMigrate) unlistenMigrate();
  unlistenMigrate = null;
  if (focusHandler) window.removeEventListener("focus", focusHandler);
  focusHandler = null;
  if (resizeObserver) resizeObserver.disconnect();
  resizeObserver = null;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  // 窗口关闭即释放 Rust 侧的目录树：不释放的话，扫过整盘的会话会一直占着内存
  if (sessionId.value) {
    invoke("disk_scan_release", { sessionId: sessionId.value }).catch(() => {});
  }
});
</script>

<template>
  <div class="tool-disk">
    <header class="dk-head">
      <div class="dk-head-main">
        <h2>{{ t("toolbox.registry.toolDisk") }}</h2>
        <p class="dk-sub">{{ t("toolbox.disk.subtitle") }}</p>
      </div>
      <div class="dk-head-actions">
        <button v-if="records.length" class="btn-ghost sm" data-role="open-records" @click="showRecords = true">
          <Icon name="layers" :size="13" />{{ t("toolbox.disk.records", { n: records.length }) }}
        </button>
        <button class="btn-ghost sm" :disabled="busyHeavy || !!loadError" data-role="pick-folder" @click="pickFolder">
          <Icon name="folder" :size="13" />{{ t("toolbox.disk.pickFolder") }}
        </button>
        <button v-if="scanning" class="btn-ghost sm danger" data-role="cancel-scan" @click="cancelScan">
          <Icon name="x" :size="13" />{{ t("toolbox.disk.cancel") }}
        </button>
        <button v-else-if="summary" class="btn-ghost sm" :disabled="busyHeavy" data-role="rescan" @click="scan(summary.root)">
          <Icon name="repeat" :size="13" />{{ t("toolbox.disk.rescan") }}
        </button>
      </div>
    </header>

    <p v-if="loadError" class="dk-error" data-role="desktop-error">{{ loadError }}</p>

    <!-- 扫描根是链接 / 在链接内：顶部警示（扫描中与结果页都要看得见） -->
    <section v-if="rootInfo" class="dk-card dk-link-banner" data-role="root-link-banner">
      <Icon name="alert" :size="14" />
      <span class="dk-link-banner-text">
        {{ t(rootInfo.crossDrive ? "toolbox.disk.rootCrossDrive" : "toolbox.disk.rootIsLink", { path: rootInfo.path, real: rootInfo.realPath }) }}
      </span>
      <button class="btn-ghost xs" data-role="scan-real" @click="scan(rootInfo.realPath)">{{ t("toolbox.disk.scanReal") }}</button>
      <button class="dk-mini" :title="t('toolbox.disk.migrateClose')" data-role="root-link-dismiss" @click="rootInfo = null"><Icon name="x" :size="12" /></button>
    </section>

    <section v-if="drives.length" class="dk-drives">
      <button
        v-for="drive in drives"
        :key="drive.root"
        class="dk-drive"
        :class="{ on: activeRoot === drive.root }"
        :data-role="'drive-' + driveLetter(drive.root).replace(':', '')"
        :disabled="busyHeavy"
        @click="scan(drive.root)"
      >
        <span class="dk-drive-top">
          <b>{{ driveLetter(drive.root) }}</b>
          <span class="dk-drive-name">{{ drive.label || t("toolbox.disk.driveLocal") }}</span>
        </span>
        <span v-if="Number(drive.total) > 0" class="dk-drive-bar">
          <i :style="{ width: percentWidth(Number(drive.total) - Number(drive.free), drive.total) }"></i>
        </span>
        <span class="dk-drive-cap">
          <template v-if="Number(drive.total) > 0">
            {{ t("toolbox.disk.driveFree", { free: formatBytes(drive.free), total: formatBytes(drive.total) }) }}
          </template>
          <template v-else>{{ t("toolbox.disk.driveUnknownCap") }}</template>
        </span>
      </button>
    </section>

    <section v-if="scanning" class="dk-card dk-scan" data-role="scan-progress">
      <div class="dk-scan-head">
        <b>{{ t("toolbox.disk.scanning") }}</b>
        <span class="dk-scan-stat">{{ t("toolbox.disk.scanStat", { entries: progress.entries.toLocaleString(), bytes: formatBytes(progress.bytes) }) }}</span>
      </div>
      <div class="dk-scan-bar"><i></i></div>
      <div class="dk-scan-path" :title="progress.path">{{ progress.path }}</div>
    </section>

    <section v-if="migrateRun" class="dk-card dk-scan dk-migrate" data-role="migrate-progress">
      <div class="dk-scan-head">
        <b>
          {{ t(migrateRun.kind === "rollback" ? "toolbox.disk.rollback" : "toolbox.disk.migrate") }}
          · {{ t(`toolbox.disk.${MIGRATE_PHASE_KEYS[migrateRun.phase] || "migratePhaseCopy"}`) }}
        </b>
        <span class="dk-scan-stat">
          {{ formatBytes(migrateRun.copiedBytes) }} / {{ formatBytes(migrateRun.totalBytes) }}
          · {{ migrateRun.files.toLocaleString() }} / {{ migrateRun.totalFiles.toLocaleString() }}
        </span>
      </div>
      <div class="dk-scan-bar"><i class="det" :style="{ width: migratePercent + '%' }"></i></div>
      <div class="dk-scan-path" :title="migrateRun.current">{{ migrateRun.current }}</div>
      <p v-if="migrateRun.error" class="dk-error" data-role="migrate-run-error">{{ t("toolbox.disk.migrateFailed", { error: migrateRun.error }) }}</p>
      <div class="dk-migrate-foot">
        <template v-if="!migrateRun.error">
          <span class="dk-hint">{{ t("toolbox.disk.migrateRunningHint") }}</span>
          <button class="btn-ghost sm danger" :disabled="migrateRun.canceling" data-role="migrate-cancel" @click="cancelMigrate">
            {{ migrateRun.canceling ? t("toolbox.disk.migrateCanceling") : t("toolbox.disk.migrateCancel") }}
          </button>
        </template>
        <button v-else class="btn-ghost sm danger" data-role="migrate-retry" @click="retryMigrate">{{ t("toolbox.disk.migrateRetry") }}</button>
        <button v-if="migrateRun.error" class="btn-ghost sm" data-role="migrate-close" @click="closeMigrateRun">{{ t("toolbox.disk.migrateClose") }}</button>
      </div>
    </section>

    <template v-else-if="summary">
      <section class="dk-summary" data-role="summary">
        <span class="dk-sum-chip strong">{{ t("toolbox.disk.sumTotal", { size: formatBytes(summary.totalBytes) }) }}</span>
        <span class="dk-sum-chip">{{ t("toolbox.disk.sumFiles", { n: Number(summary.files || 0).toLocaleString() }) }}</span>
        <span class="dk-sum-chip">{{ t("toolbox.disk.sumDirs", { n: Number(summary.dirs || 0).toLocaleString() }) }}</span>
        <span v-if="Number(summary.links) > 0" class="dk-sum-chip">{{ t("toolbox.disk.sumLinks", { n: Number(summary.links).toLocaleString() }) }}</span>
        <span class="dk-sum-chip">{{ t("toolbox.disk.sumElapsed", { duration: durationText(summary.elapsedMs) }) }}</span>
        <span v-if="Number(summary.errors) > 0" class="dk-sum-chip warn">{{ t("toolbox.disk.sumErrors", { n: summary.errors }) }}</span>
        <span v-if="summary.truncated" class="dk-sum-chip warn">{{ t("toolbox.disk.sumTruncated") }}</span>
        <span v-if="staleNotice" class="dk-sum-chip warn" data-role="stale-notice">{{ t("toolbox.disk.staleNotice") }}</span>
      </section>

      <section class="dk-body">
        <div class="dk-left dk-card">
          <nav class="dk-crumbs" data-role="crumbs">
            <template v-for="(crumb, index) in navStack" :key="crumb.id">
              <span v-if="index > 0" class="dk-crumb-sep">›</span>
              <button
                class="dk-crumb"
                :class="{ last: index === navStack.length - 1 }"
                :title="crumb.path"
                @click="loadNode(crumb.id, { truncateTo: index })"
              >{{ index === 0 ? rootLabel(crumb.name) : crumb.name }}</button>
            </template>
          </nav>

          <div class="dk-node-stat" data-role="node-stat">
            <span v-if="activeNode">{{ t("toolbox.disk.nodeStat", { size: formatBytes(activeNode.size), files: Number(activeNode.files || 0).toLocaleString(), dirs: Number(activeNode.dirs || 0).toLocaleString() }) }}</span>
            <span v-if="activeNode && activeNode.ownBytes > 0" class="dk-hint">· {{ t("toolbox.disk.nodeOwn", { size: formatBytes(activeNode.ownBytes) }) }}</span>
            <span v-if="childMeta.truncated" class="dk-warn">· {{ t("toolbox.disk.childrenTruncated", { n: childMeta.childCount }) }}</span>
            <span v-if="currentLinks.length" class="dk-hint" data-role="link-count">· {{ t("toolbox.disk.linkCount", { n: currentLinks.length }) }}</span>
            <span class="dk-stat-actions">
              <button v-if="rows.rows.length" class="btn-ghost xs" :disabled="busyHeavy" :title="t('toolbox.disk.selectAllHint')" data-role="select-all" @click="selectAllRows">{{ t("toolbox.disk.selectAll") }}</button>
              <button class="btn-ghost xs" :disabled="busyHeavy" :title="activeNode?.path" data-role="migrate-current" @click="openMigrate(activeNode?.path, rootLabel(activeNode?.name))">
                <Icon name="arrow-up-right" :size="12" />{{ t("toolbox.disk.migrateCurrent") }}
              </button>
              <button class="btn-ghost xs" :title="activeNode?.path" data-role="copy-dir-path" @click="copyPaths(activeNode?.path)">{{ t("toolbox.disk.copyDirPath") }}</button>
              <button v-if="navStack.length > 1" class="btn-ghost xs" data-role="go-up" @click="goUp"><Icon name="chevron-left" :size="12" />{{ t("toolbox.disk.goUp") }}</button>
            </span>
          </div>

          <div v-if="selection.count" class="dk-selbar" data-role="selection-bar">
            <b>{{ t("toolbox.disk.selected", { n: selection.count, size: formatBytes(selection.size) }) }}</b>
            <button class="btn-ghost xs danger" :disabled="deleting" data-role="delete-selected" @click="deleteEntries([...selected.values()])">
              <Icon name="trash" :size="12" />{{ t("toolbox.disk.delete") }}
            </button>
            <button class="btn-ghost xs" data-role="copy-selected" @click="copyPaths(selectedPaths())">{{ t("toolbox.disk.copyPath") }}</button>
            <button class="btn-ghost xs" data-role="clear-selection" @click="clearSelection">{{ t("toolbox.disk.clearSelection") }}</button>
          </div>

          <div class="dk-rows" data-role="rows">
            <div v-for="row in rows.rows" :key="row.kind + ':' + row.name" class="dk-row" :class="row.kind">
              <input
                class="dk-check"
                type="checkbox"
                :checked="isSelected(row.kind === 'dir' ? joinPath(activeNode?.path, row.name) : row.path)"
                :title="t('toolbox.disk.select')"
                @change="toggleSelect(row.kind === 'dir' ? entryOfDir(row) : entryOfFile(row))"
              />
              <button class="dk-row-main" :data-role="'row-' + row.kind" @click="row.kind === 'dir' ? drill(row.id) : reveal(row.path)">
                <span class="dk-row-ico"><Icon :name="row.kind === 'dir' ? 'folder' : 'file'" :size="14" /></span>
                <span class="dk-row-name" :title="row.name">{{ row.name }}</span>
                <span class="dk-row-bar"><i :style="{ width: percentWidth(row.size, activeNode?.size) }"></i></span>
                <span class="dk-row-size">{{ formatBytes(row.size) }}</span>
                <span class="dk-row-pct">{{ formatPercent(row.size, activeNode?.size) }}</span>
              </button>
              <button class="dk-mini" :title="t('toolbox.disk.open')" @click="openEntry(row.kind === 'dir' ? joinPath(activeNode?.path, row.name) : row.path)">
                <Icon name="open" :size="12" />
              </button>
              <button class="dk-mini" :title="t('toolbox.disk.reveal')" @click="reveal(row.kind === 'dir' ? joinPath(activeNode?.path, row.name) : row.path)">
                <Icon name="eye" :size="12" />
              </button>
              <button
                v-if="row.kind === 'dir'"
                class="dk-mini"
                :title="t('toolbox.disk.migrate')"
                :disabled="busyHeavy"
                data-role="row-migrate"
                @click="openMigrate(joinPath(activeNode?.path, row.name), row.name)"
              >
                <Icon name="arrow-up-right" :size="12" />
              </button>
              <button
                class="dk-mini danger"
                :title="t('toolbox.disk.delete')"
                :disabled="deleting || busyHeavy"
                @click="deleteEntries([row.kind === 'dir' ? entryOfDir(row) : entryOfFile(row)])"
              >
                <Icon name="trash" :size="12" />
              </button>
            </div>
            <p v-if="!rows.rows.length && !loadingNode && !currentLinks.length" class="dk-empty-line">{{ t("toolbox.disk.dirEmpty") }}</p>

            <!-- 链接（junction / 符号链接）：迁移过的目录在原位置就长这样。不计数、打标签、不给删/迁 -->
            <div v-for="link in currentLinks" :key="'link:' + link.name" class="dk-row link" data-role="row-link">
              <span class="dk-check-gap" aria-hidden="true"></span>
              <button class="dk-row-main" :title="linkOpenPath(link)" @click="openEntry(linkOpenPath(link))">
                <span class="dk-row-ico"><Icon name="link" :size="14" /></span>
                <span class="dk-row-name">{{ link.name }}</span>
                <span class="dk-row-badge">{{ t("toolbox.disk.linkBadge") }}</span>
                <span class="dk-row-bar"></span>
                <span class="dk-row-size">—</span>
                <span class="dk-row-pct"></span>
              </button>
              <button class="dk-mini" :title="t('toolbox.disk.reveal')" @click="reveal(joinPath(activeNode?.path, link.name))">
                <Icon name="eye" :size="12" />
              </button>
              <button class="dk-mini" :title="t('toolbox.disk.copyPath')" @click="copyPaths(joinPath(activeNode?.path, link.name))">
                <Icon name="copy" :size="12" />
              </button>
            </div>
            <p v-if="filesMeta.truncated" class="dk-more">
              <span>{{ t("toolbox.disk.filesTruncated", { n: Number(filesMeta.fileCount || 0).toLocaleString() }) }}</span>
              <button
                v-if="currentFiles.length < FILES_LIMIT_MAX"
                class="btn-ghost xs"
                :disabled="loadingNode"
                data-role="show-more"
                @click="showMoreFiles"
              >{{ t("toolbox.disk.showMore", { n: hiddenFiles.toLocaleString() }) }}</button>
            </p>
          </div>
        </div>

        <div class="dk-right">
          <div class="dk-card dk-treemap-wrap" data-role="treemap-wrap">
            <canvas
              ref="treemapRef"
              class="dk-treemap"
              data-role="treemap"
              @mousemove="onCanvasMove"
              @mouseleave="onCanvasLeave"
              @click="onCanvasClick"
            ></canvas>
            <p v-if="!treemapDirs.length" class="dk-treemap-empty">{{ t("toolbox.disk.noSubdirs") }}</p>
            <div v-if="hover" class="dk-tip" :style="tipStyle">
              <b>{{ hover.name }}</b>
              <span>{{ formatBytes(hover.size) }} · {{ hover.percent }}</span>
            </div>
          </div>

          <div class="dk-card dk-topfiles">
            <header class="dk-topfiles-head">
              <b>{{ t("toolbox.disk.topFilesTitle") }}</b>
              <span class="dk-hint">{{ t("toolbox.disk.topFilesHint") }}</span>
            </header>
            <div class="dk-topfiles-list" data-role="top-files">
              <div v-for="file in topFiles" :key="file.path" class="dk-file">
                <input
                  class="dk-check"
                  type="checkbox"
                  :checked="isSelected(String(file.path))"
                  :title="t('toolbox.disk.select')"
                  @change="toggleSelect(entryOfFile({ path: file.path, name: fileName(file.path), size: file.size }))"
                />
                <button class="dk-file-main" :title="file.path" @click="reveal(file.path)">
                  <span class="dk-file-name">{{ fileName(file.path) }}</span>
                  <span class="dk-file-size">{{ formatBytes(file.size) }}</span>
                </button>
                <button
                  class="dk-mini danger"
                  :title="t('toolbox.disk.delete')"
                  :disabled="deleting"
                  @click="deleteEntries([entryOfFile({ path: file.path, name: fileName(file.path), size: file.size })])"
                >
                  <Icon name="trash" :size="12" />
                </button>
              </div>
              <p v-if="!topFiles.length" class="dk-empty-line">{{ t("toolbox.disk.topFilesEmpty") }}</p>
            </div>
          </div>
        </div>
      </section>
    </template>

    <section v-else class="dk-card dk-empty-state" data-role="empty">
      <Icon name="hard-drive" :size="30" />
      <b>{{ t("toolbox.disk.emptyTitle") }}</b>
      <p>{{ t("toolbox.disk.emptyHint") }}</p>
    </section>

    <!-- 迁移对话框：真实体积/空间都是 Rust 勘察出来的，检查没过不给开始 -->
    <div v-if="migratePlan" class="dk-mask" data-role="migrate-dialog">
      <div class="dk-dialog">
        <h3>{{ t("toolbox.disk.migrateTitle") }}</h3>
        <div class="dk-field">
          <span>{{ t("toolbox.disk.migrateSource") }}</span>
          <b :title="migratePlan.source">{{ migratePlan.source }}</b>
        </div>
        <div class="dk-field">
          <span>{{ t("toolbox.disk.migrateSize") }}</span>
          <b v-if="migratePlan.check">
            {{ formatBytes(migratePlan.check.bytes) }} · {{ t("toolbox.disk.migrateFiles", { n: Number(migratePlan.check.files || 0).toLocaleString() }) }}
          </b>
          <b v-else>—</b>
        </div>
        <div class="dk-field">
          <span>{{ t("toolbox.disk.migrateTarget") }}</span>
          <span class="dk-targets">
            <button
              v-for="drive in migrateTargets"
              :key="drive.root"
              class="dk-chip"
              :class="{ on: migratePlan.targetParent === drive.root }"
              :data-role="'migrate-target-' + driveLetter(drive.root).replace(':', '')"
              @click="migratePlan.targetParent = drive.root; runMigrateCheck()"
            >{{ driveLetter(drive.root) }}</button>
            <button class="btn-ghost xs" data-role="migrate-pick" @click="pickMigrateTarget">
              <Icon name="folder" :size="12" />{{ t("toolbox.disk.migratePickTarget") }}
            </button>
          </span>
        </div>
        <p v-if="migratePlan.busy" class="dk-hint" data-role="migrate-checking">{{ t("toolbox.disk.migrateChecking") }}</p>
        <p v-else-if="migratePlan.error" class="dk-warn" data-role="migrate-check-error">{{ t("toolbox.disk.migrateCheckFailed", { error: migratePlan.error }) }}</p>
        <div v-else-if="migratePlan.check" class="dk-field">
          <span>{{ t("toolbox.disk.migrateTargetFree") }}</span>
          <b>{{ formatBytes(migratePlan.check.freeBytes) }} · {{ t("toolbox.disk.migrateNeeded", { size: formatBytes(migratePlan.check.neededBytes) }) }}</b>
        </div>
        <p v-if="migratePlan.realInfo" class="dk-note" data-role="migrate-link-note">
          {{ t("toolbox.disk.migrateLinkNote", { real: migratePlan.realInfo.realPath }) }}
        </p>
        <!-- 可搬但有风险的地方（UWP 数据、系统组件、Temp 等）：如实提醒，不替用户决定 -->
        <p v-for="warning in (migratePlan.check?.warnings || [])" :key="warning" class="dk-note" data-role="migrate-warning">{{ warning }}</p>
        <p class="dk-note">{{ t("toolbox.disk.migrateWarn") }}</p>
        <div class="dk-dialog-foot">
          <button class="btn-ghost sm" data-role="migrate-plan-close" @click="closeMigratePlan">{{ t("common.cancel") }}</button>
          <button class="btn-primary sm" :disabled="!migratePlan.check || migratePlan.busy" data-role="migrate-start" @click="startMigrate">
            {{ t("toolbox.disk.migrateStart") }}
          </button>
        </div>
      </div>
    </div>

    <!-- 迁移记录：回滚入口。记录里带 source/target，回滚时先校验「原路径确实是指向该目标的链接」 -->
    <div v-if="showRecords" class="dk-mask" data-role="records-dialog">
      <div class="dk-dialog wide">
        <h3>{{ t("toolbox.disk.recordsTitle") }}</h3>
        <div v-if="records.length" class="dk-record-list">
          <div v-for="record in records" :key="record.source" class="dk-record" data-role="record">
            <div class="dk-record-main">
              <b>{{ fileName(record.source) }}</b>
              <span class="dk-hint" :title="record.source + ' → ' + record.target">{{ record.source }} → {{ record.target }}</span>
              <span class="dk-hint">{{ formatBytes(record.bytes) }} · {{ new Date(record.at).toLocaleString() }}</span>
            </div>
            <button class="btn-ghost xs" :disabled="busyHeavy" data-role="rollback" @click="startRollback(record)">{{ t("toolbox.disk.rollback") }}</button>
            <button class="btn-ghost xs" data-role="record-forget" @click="forgetRecord(record)">{{ t("toolbox.disk.forget") }}</button>
          </div>
        </div>
        <p v-else class="dk-empty-line">{{ t("toolbox.disk.recordsEmpty") }}</p>
        <div class="dk-dialog-foot">
          <button class="btn-ghost sm" data-role="records-close" @click="showRecords = false">{{ t("toolbox.disk.migrateClose") }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-disk { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; padding: 16px 18px 18px; }

.dk-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-shrink: 0; }
.dk-head h2 { margin: 0 0 4px; font-size: var(--fs-xl); }
.dk-sub { margin: 0; color: var(--muted); font-size: var(--fs-md); }
.dk-head-actions { display: flex; gap: 8px; flex-shrink: 0; }
.danger { color: var(--danger); }
.dk-error { margin: 0; padding: 10px 12px; border: 1px solid var(--danger); border-radius: var(--r-sm); color: var(--danger); font-size: var(--fs-sm); }

.dk-drives { display: flex; gap: 10px; flex-wrap: wrap; flex-shrink: 0; }
.dk-drive {
  display: flex; flex-direction: column; gap: 5px; min-width: 150px;
  padding: 9px 12px; background: var(--card); border: 1px solid var(--card-border);
  border-radius: var(--r-md); cursor: pointer; text-align: left; color: var(--text);
}
.dk-drive:hover:not(:disabled) { border-color: var(--primary); }
.dk-drive.on { border-color: var(--primary); background: var(--primary-soft); }
.dk-drive:disabled { opacity: 0.6; cursor: default; }
.dk-drive-top { display: flex; align-items: baseline; gap: 8px; }
.dk-drive-top b { font-size: var(--fs-lg); }
.dk-drive-name { color: var(--text-weak); font-size: var(--fs-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
.dk-drive-bar { display: block; height: 5px; border-radius: var(--r-pill); background: var(--well); overflow: hidden; }
.dk-drive-bar i { display: block; height: 100%; background: var(--primary); border-radius: var(--r-pill); }
.dk-drive-cap { color: var(--muted); font-size: var(--fs-xs); }

.dk-card { background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); }

.dk-scan { padding: 12px 14px; flex-shrink: 0; }
.dk-scan-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dk-scan-stat { color: var(--muted); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.dk-scan-bar { margin: 9px 0 8px; height: 6px; border-radius: var(--r-pill); background: var(--well); overflow: hidden; }
/* 总量未知的扫描没有百分比可算：走不定态条纹，避免假进度条 */
.dk-scan-bar i {
  display: block; height: 100%; width: 34%; border-radius: var(--r-pill); background: var(--primary);
  animation: dk-indeterminate 1.1s ease-in-out infinite;
}
@keyframes dk-indeterminate { 0% { margin-left: -34%; } 100% { margin-left: 100%; } }
.dk-scan-path { color: var(--text-soft); font-size: var(--fs-xs); font-family: var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.dk-summary { display: flex; flex-wrap: wrap; gap: 8px; flex-shrink: 0; }
.dk-link-banner { display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex-shrink: 0; background: var(--amber-soft); color: var(--warn-deep); font-size: var(--fs-sm); }
.dk-link-banner-text { flex: 1; min-width: 0; word-break: break-all; }
.dk-sum-chip { padding: 3px 10px; border-radius: var(--r-pill); background: var(--well); color: var(--text-weak); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.dk-sum-chip.strong { background: var(--primary-soft); color: var(--primary-hover); font-weight: 600; }
.dk-sum-chip.warn { background: var(--amber-soft); color: var(--warn-deep); }

.dk-body { display: grid; grid-template-columns: minmax(400px, 48%) 1fr; gap: 12px; flex: 1; min-height: 0; }
.dk-left { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.dk-right { display: flex; flex-direction: column; gap: 12px; min-height: 0; }

.dk-crumbs { display: flex; align-items: center; gap: 2px; padding: 8px 10px 6px; flex-wrap: wrap; }
.dk-crumb {
  max-width: 180px; padding: 2px 6px; border: none; background: transparent; color: var(--text-weak);
  font-size: var(--fs-sm); border-radius: var(--r-xs); cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dk-crumb:hover { background: var(--well-hover); color: var(--text); }
.dk-crumb.last { color: var(--text); font-weight: 600; }
.dk-crumb-sep { color: var(--muted); font-size: var(--fs-sm); }

.dk-node-stat { display: flex; align-items: center; gap: 6px; padding: 0 10px 8px; color: var(--text-soft); font-size: var(--fs-xs); border-bottom: 1px solid var(--border); flex-wrap: wrap; font-variant-numeric: tabular-nums; }
.dk-hint { color: var(--muted); font-size: var(--fs-xs); }
.dk-warn { color: var(--warn-deep); }
.dk-stat-actions { margin-left: auto; display: flex; gap: 4px; }

.dk-selbar {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  background: var(--primary-soft); border-bottom: 1px solid var(--border);
  font-size: var(--fs-sm); font-variant-numeric: tabular-nums;
}
.dk-selbar b { color: var(--primary-hover); }

.dk-rows { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 6px 8px; }
.dk-row { display: flex; align-items: center; gap: 2px; border-radius: var(--r-xs); }
.dk-row:hover { background: var(--well); }
.dk-check { flex-shrink: 0; margin: 0 2px 0 4px; accent-color: var(--primary); cursor: pointer; }
.dk-row-main {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px;
  padding: 5px 6px; border: none; background: transparent; color: var(--text);
  cursor: pointer; text-align: left; font-size: var(--fs-sm);
}
.dk-row-ico { color: var(--text-soft); flex-shrink: 0; display: grid; place-items: center; }
.dk-row.dir .dk-row-ico { color: var(--primary-hover); }
.dk-row-name { flex: 1 1 auto; min-width: 60px; max-width: 42%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 链接行：与普通行视觉区分（灰一点 + 「链接」角标），且不可勾选（没有复选框的位置留白） */
.dk-check-gap { width: 22px; flex-shrink: 0; }
.dk-row.link .dk-row-ico { color: var(--muted); }
.dk-row-badge { flex-shrink: 0; padding: 1px 6px; border-radius: var(--r-pill); background: var(--well); color: var(--text-soft); font-size: var(--fs-xs); }
.dk-row-bar { flex: 0 1 36px; min-width: 24px; height: 4px; border-radius: var(--r-pill); background: var(--well); overflow: hidden; }
.dk-row-bar i { display: block; height: 100%; background: var(--primary); opacity: 0.75; border-radius: var(--r-pill); }
.dk-row-size { flex-shrink: 0; min-width: 58px; text-align: right; font-variant-numeric: tabular-nums; color: var(--text-weak); }
.dk-row-pct { flex-shrink: 0; min-width: 40px; text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); font-size: var(--fs-xs); }
/* 行内动作常显（不做 hover 才出现）：磁盘工具的主要任务就是「找到它、处置它」，
   藏起来的按钮等于没有按钮——用户实测反馈过这一点。 */
.dk-mini {
  flex-shrink: 0; width: 22px; height: 22px; display: grid; place-items: center;
  border: none; background: transparent; color: var(--text-soft); border-radius: var(--r-xs); cursor: pointer;
}
.dk-mini:hover:not(:disabled) { background: var(--well-hover); color: var(--text); }
.dk-mini.danger:hover:not(:disabled) { color: var(--danger); }
.dk-mini:disabled { opacity: 0.4; cursor: default; }
.dk-empty-line { margin: 12px; color: var(--muted); font-size: var(--fs-sm); }
.dk-more { margin: 8px 12px 4px; color: var(--muted); font-size: var(--fs-xs); }

.dk-treemap-wrap { position: relative; flex: 1 1 56%; min-height: 160px; overflow: hidden; }
.dk-treemap { display: block; width: 100%; height: 100%; }
.dk-treemap-empty { position: absolute; inset: 0; margin: 0; display: grid; place-items: center; color: var(--muted); font-size: var(--fs-sm); pointer-events: none; }
.dk-tip {
  position: absolute; z-index: 2; max-width: 280px; padding: 5px 9px;
  display: flex; flex-direction: column; gap: 2px; pointer-events: none;
  background: var(--card); border: 1px solid var(--border-strong); border-radius: var(--r-sm);
  box-shadow: var(--shadow-md, 0 4px 14px rgba(0, 0, 0, 0.25)); font-size: var(--fs-xs);
}
.dk-tip span { color: var(--muted); font-variant-numeric: tabular-nums; }

.dk-topfiles { flex: 1 1 44%; display: flex; flex-direction: column; min-height: 140px; overflow: hidden; }
.dk-topfiles-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 9px 12px 7px; border-bottom: 1px solid var(--border); }
.dk-topfiles-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 6px 8px; }
.dk-file { display: flex; align-items: center; gap: 2px; border-radius: var(--r-xs); }
.dk-file:hover { background: var(--well); }
.dk-file-main {
  flex: 1; min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 4px 6px; border: none; background: transparent; color: var(--text);
  font-size: var(--fs-sm); cursor: pointer; text-align: left;
}
.dk-file-name { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dk-file-size { flex-shrink: 0; color: var(--text-weak); font-variant-numeric: tabular-nums; }

.dk-empty-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 46px 20px; color: var(--text-weak); text-align: center; flex-shrink: 0; }
.dk-empty-state b { color: var(--text); font-size: var(--fs-lg); }
.dk-empty-state p { margin: 0; color: var(--muted); font-size: var(--fs-sm); max-width: 460px; line-height: var(--lh-body); }

/* 迁移进度：进度条是确定态（总量在勘察阶段就量过），与扫描的不定态条纹区分 */
.dk-scan-bar i.det { width: 0; animation: none; margin-left: 0; transition: width 0.2s linear; }
.dk-migrate-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; }

/* 弹窗（z-index 低于全局确认弹窗：迁移确认是套在对话框之上再确认一次的） */
.dk-mask { position: fixed; inset: 0; z-index: 200; background: rgba(15, 18, 24, 0.45); backdrop-filter: blur(3px); display: grid; place-items: center; }
.dk-dialog { width: 560px; max-width: calc(100vw - 48px); max-height: calc(100vh - 64px); overflow-y: auto; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: 18px 20px 16px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28); }
.dk-dialog.wide { width: 640px; }
.dk-dialog h3 { margin: 0 0 12px; font-size: var(--fs-lg); }
.dk-field { display: flex; align-items: flex-start; gap: 10px; padding: 5px 0; font-size: var(--fs-sm); }
.dk-field > span:first-child { flex-shrink: 0; width: 92px; color: var(--muted); }
.dk-field > b { min-width: 0; word-break: break-all; font-weight: 600; }
.dk-targets { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dk-chip { padding: 3px 12px; border: 1px solid var(--border-strong); background: var(--ghost); color: var(--text); border-radius: var(--r-pill); cursor: pointer; font-size: var(--fs-sm); }
.dk-chip:hover { border-color: var(--primary); }
.dk-chip.on { border-color: var(--primary); background: var(--primary-soft); color: var(--primary-hover); font-weight: 600; }
.dk-note { margin: 10px 0 0; padding: 8px 10px; border-radius: var(--r-sm); background: var(--amber-soft); color: var(--warn-deep); font-size: var(--fs-xs); line-height: var(--lh-body); }
.dk-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }

.dk-record-list { display: flex; flex-direction: column; gap: 6px; max-height: 46vh; overflow-y: auto; }
.dk-record { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--r-sm); }
.dk-record-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dk-record-main b { font-size: var(--fs-sm); }
.dk-record-main .dk-hint { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
