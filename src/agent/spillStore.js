// 溢出结果（spill）的落盘与读回。
//
// 为什么走平台 invoke 而不是写临时文件、也不用 toolboxStore：
//  - 双端都要工作（浏览器端一样会有大结果），而 platform/invoke 已经把两端抹平：
//    桌面端 save_data/load_data 落 <应用数据目录>/<key>.json（参与每日自动备份），浏览器端落 IndexedDB。
//  - 于是 spill 完全不需要动 Rust 侧 IPC 契约。
//  - 不用 toolboxStore 的原因：它在 Node 单测环境没有可用后端（localStorage 缺失）会静默失败；
//    走 invoke 则能把「平台层」当边界，单测直接注入内存 store，行为可断言。
//
// 治理（对应 DSH 的 cleanupPeriodDays）：条数上限 + 天数上限，用一个索引键记账。
// 不枚举目录（那需要新的 Rust 命令）：索引里记着最近写过的 spill key，裁剪只按索引走。
import { invoke } from "../platform/invoke.js";

export const SPILL_PREFIX = "spill:";
export const SPILL_INDEX_KEY = "spillIndex";
export const SPILL_MAX_ITEMS = 30;
export const SPILL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** 单份 spill 上限：超过 5 MB 的文本不再落盘（调用方降级为裁剪）。 */
export const SPILL_MAX_CHARS = 5_000_000;
/** 索引裁剪上限：比条目上限宽一些，避免索引本身被裁剪逻辑反复改写。 */
const INDEX_MAX = SPILL_MAX_ITEMS * 2;

/** 生成 spill key：随机 + 工具名安全片段，便于用户认领「这是哪一步的大结果」。 */
export function spillKey(tool = "", random = "") {
  const slug = String(tool).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  const token = String(random || Math.random().toString(36).slice(2, 10));
  return `${SPILL_PREFIX}${slug || "result"}-${token}`;
}

/** 从索引里挑出该删的：超条数（按时间倒序保留前 N）或超天数。纯函数，便于单测。 */
export function pickExpired(entries = [], now = Date.now()) {
  const sorted = [...entries].sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0));
  return sorted.filter((item, index) => index >= SPILL_MAX_ITEMS || now - (Number(item?.createdAt) || 0) > SPILL_MAX_AGE_MS);
}

/**
 * 默认存储：桌面端与应用主数据同级（save_data/load_data），浏览器端落 IndexedDB。
 * 「键不存在」的约定来自 Rust：load_data 对不存在的文件返回 []，所以用 [] 当哨兵。
 */
function defaultStore() {
  return {
    read: async (key) => {
      const value = await invoke("load_data", { key });
      if (Array.isArray(value) && value.length === 0) return null;
      return value ?? null;
    },
    write: async (key, value) => {
      await invoke("save_data", { key, data: value ?? null });
    },
    // 正文无法枚举删除（缺 Rust 命令），只把索引摘掉：残留的孤儿文件不参与任何读取路径，
    // 也不出现在清单里；下一次写满上限时会被新条目挤出索引，等用户手动清目录即可。
    remove: async () => {},
  };
}

/**
 * 建立 spill 读写。
 * `sanitize` 在写入前对文本做一次脱敏——spill 的内容会落盘，比内存里的更该过一遍。
 * `store` 可注入（{ read, write, remove }），不注入时用平台 invoke 的默认实现。
 */
export function createSpillStore(options = {}) {
  const store = options.store || defaultStore();
  const sanitize = typeof options.sanitize === "function" ? options.sanitize : (text) => text;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  // 统一读口径：注入实现可以只接受一个 key，也可以带一个 fallback
  const readRaw = async (key, fallback = null) => {
    const value = await store.read(key, fallback);
    return value === undefined || value === null ? fallback : value;
  };

  const readIndex = async () => {
    const raw = await readRaw(SPILL_INDEX_KEY, []);
    return Array.isArray(raw) ? raw.filter((item) => item && typeof item.key === "string") : [];
  };
  const writeIndex = async (entries) => {
    const keep = [...entries].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, INDEX_MAX);
    await store.write(SPILL_INDEX_KEY, keep);
    return keep;
  };

  return {
    /** 写入一份溢出结果。成功返回 { key, chars }；超限或失败返回 null（调用方据此降级为裁剪）。 */
    async save(text, meta = {}) {
      const source = typeof text === "string" ? text : String(text ?? "");
      if (!source || source.length > SPILL_MAX_CHARS) return null;
      const key = spillKey(meta.tool, meta.random);
      try {
        const clean = sanitize(source);
        const payload = typeof clean === "string" ? clean : String(clean ?? "");
        const createdAt = now();
        const entry = { key, chars: payload.length, tool: String(meta.tool || ""), createdAt };
        await store.write(key, { text: payload, createdAt, tool: entry.tool });
        const entries = [entry, ...(await readIndex())];
        const expired = pickExpired(entries, createdAt);
        const expiredKeys = new Set(expired.map((item) => item.key));
        await writeIndex(entries.filter((item) => !expiredKeys.has(item.key)));
        await Promise.all(expired.map((item) => store.remove(item.key)));
        return { key, chars: payload.length };
      } catch {
        // 落盘失败不该让一次成功的工具调用变成失败：调用方会降级成裁剪
        return null;
      }
    },

    /** 读回一份溢出结果原文；不存在返回 null。 */
    async read(key) {
      const value = await readRaw(String(key || ""), null);
      return value && typeof value.text === "string" ? value.text : null;
    },

    /** 清单（不含正文）：给 UI 展示「这次运行落了几份大结果」。 */
    async list() {
      const entries = await readIndex();
      return [...entries].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },

    /** 手动清理：按索引摘掉过期项。返回被摘掉的 key。 */
    async prune(at) {
      const stamp = Number.isFinite(Number(at)) ? Number(at) : now();
      const entries = await readIndex();
      const expired = pickExpired(entries, stamp);
      if (!expired.length) return [];
      const expiredKeys = new Set(expired.map((item) => item.key));
      await writeIndex(entries.filter((item) => !expiredKeys.has(item.key)));
      await Promise.all(expired.map((item) => store.remove(item.key)));
      return [...expiredKeys];
    },

    /** 某个 key 的元信息（chars / tool / createdAt）；不在索引里返回 null。 */
    async stat(key) {
      const target = String(key || "");
      const entry = (await readIndex()).find((item) => item.key === target);
      if (!entry) return null;
      return {
        key: target,
        chars: Math.max(Number(entry.chars) || 0, 0),
        tool: String(entry.tool || ""),
        createdAt: Number(entry.createdAt) || 0,
      };
    },

    /**
     * 清空整个 spill 区（用户可见的手动出口）。
     * 桌面端没有「按 key 删文件」的命令，所以只能把索引写成空数组 + 把每个 key 覆写成空值：
     * 空值读回即视为不存在，孤儿文件也会被截成 0 字节（save_data 是整体替换写）。
     * 不假装「文件已彻底删除」——返回的是被清掉的条目列表，UI 文案据实措辞。
     */
    async clear() {
      const entries = await readIndex();
      if (!entries.length) return { cleared: 0, chars: 0, items: [] };
      await store.write(SPILL_INDEX_KEY, []);
      await Promise.all(entries.map((item) => store.write(item.key, { text: "", createdAt: item.createdAt || 0, tool: item.tool || "" })));
      await Promise.all(entries.map((item) => store.remove(item.key)));
      return {
        cleared: entries.length,
        chars: entries.reduce((sum, item) => sum + (Number(item.chars) || 0), 0),
        items: entries.map((item) => item.key),
      };
    },
  };
}
