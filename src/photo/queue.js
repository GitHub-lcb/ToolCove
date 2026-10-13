// 上传队列：先落盘再上传。
//
// 这是整个手机端最要紧的一条不变量：照片从相机/相册拿到的那一刻先进 IndexedDB，
// 上传成功后**才**允许丢掉本地二进制。中途切走页面、锁屏、App 被杀，重开时
// 队列还在、断点续传（整张重传——单张照片几 MB，不值得做分片）。
//
// 串行上传：一次一张。手机网络下并发只会让每张都变慢、进度互相抢；
// 且 iOS 网页版切到后台随时可能被冻结，串行能让"当前这张"的状态始终清晰。
//
// 队列只管状态机与持久化；真正的网络动作（签名 + PUT）由调用方以 uploader 注入，
// 单测因此可以完全离线地验证「重试 / 去重 / 恢复 / 清理」这些容易写错的部分。
import { buildObjectKey, extensionFor, generateDeviceId } from "./keys.js";
import { validatePhotoConfig } from "./config.js";

export const QUEUE_STATE = Object.freeze({
  pending: "pending",
  uploading: "uploading",
  done: "done",
  error: "error",
});

let seq = 0;
function nextId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  seq += 1;
  return `photo-${Date.now()}-${seq}`;
}

export class PhotoQueue {
  /**
   * @param {object} deps
   *  - store：createPhotoStore() 或 createMemoryStore() 的结果
   *  - uploader：async ({ item, config }) => ({ etag })；失败请抛错（PhotoError 会原样透出）
   *  - onUpdate：状态变化回调（item 或 null 表示整个队列状态变了）
   *  - maxDone：已完成记录保留条数（历史用于"传过什么"的回看，二进制在成功时就删掉了）
   */
  constructor({ store, uploader, onUpdate = () => {}, maxDone = 500 }) {
    this.store = store;
    this.uploader = uploader;
    this.onUpdate = onUpdate;
    this.maxDone = maxDone;
    this.items = [];
    this.config = null;
    this.running = false;
    /** 本次会话新生成的设备 id（配置里没有时用），供视图回写配置。 */
    this.generatedDeviceId = "";
  }

  async init() {
    const rows = await this.store.list();
    this.items = rows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return this.items;
  }

  setConfig(config) {
    this.config = config;
  }

  stats() {
    const by = (state) => this.items.filter((item) => item.status === state).length;
    return { pending: by(QUEUE_STATE.pending), uploading: by(QUEUE_STATE.uploading), done: by(QUEUE_STATE.done), error: by(QUEUE_STATE.error), total: this.items.length };
  }

  /** 入队：key 在此刻生成（拍摄时间已知），落盘成功前不返回——返回即意味着"杀进程也不丢"。 */
  async addFiles(files, { config } = {}) {
    const cfg = config || this.config || {};
    const deviceId = /^[0-9a-f]{6}$/.test(String(cfg.deviceId || "")) ? cfg.deviceId : this.#ensureDevice();
    const added = [];
    for (const file of files) {
      const capturedAt = Number(file.capturedAt) || Date.now();
      const item = {
        id: nextId(),
        name: String(file.name || "photo.jpg"),
        type: String(file.type || ""),
        size: Number(file.size) || 0,
        capturedAt,
        createdAt: Date.now(),
        key: buildObjectKey({
          capturedAt,
          deviceId,
          ext: file.ext || extensionFor(file.name, file.type),
          prefix: cfg.prefix,
        }),
        status: QUEUE_STATE.pending,
        attempts: 0,
        error: "",
        etag: "",
        blob: file.blob,
      };
      await this.store.put(item);
      this.items.push(item);
      added.push(item);
    }
    this.onUpdate(null);
    return added;
  }

  #ensureDevice() {
    if (!this.generatedDeviceId) this.generatedDeviceId = generateDeviceId();
    return this.generatedDeviceId;
  }

  async #persist(item, { dropBlob = false } = {}) {
    const record = dropBlob ? { ...item, blob: undefined } : item;
    if (dropBlob) item.blob = undefined;
    await this.store.put(record);
  }

  /**
   * 依次上传所有 pending。配置不合法时**保持 pending 并直接返回**：
   * 照片已经安全落盘，等用户把存储配好再传，比报错退回更有用。
   */
  async pump() {
    if (this.running) return;
    const check = validatePhotoConfig(this.config || {});
    if (!check.ok) return;
    this.running = true;
    try {
      for (;;) {
        const item = this.items.find((row) => row.status === QUEUE_STATE.pending);
        if (!item) break;
        await this.#uploadOne(item);
      }
    } finally {
      this.running = false;
      this.onUpdate(null);
    }
  }

  async #uploadOne(item) {
    item.status = QUEUE_STATE.uploading;
    item.attempts += 1;
    await this.#persist(item);
    this.onUpdate(item);
    try {
      const result = await this.uploader({ item, config: this.config });
      item.status = QUEUE_STATE.done;
      item.etag = result?.etag || "";
      item.error = "";
      item.doneAt = Date.now();
      await this.#persist(item, { dropBlob: true });
      await this.#pruneDone();
    } catch (e) {
      item.status = QUEUE_STATE.error;
      item.error = String(e?.message || e);
      await this.#persist(item);
    }
    this.onUpdate(item);
  }

  /** 手动重试：置回 pending 再跑。失败原因不清空——下次失败会覆盖，成功才算翻篇。 */
  async retry(id) {
    const item = this.items.find((row) => row.id === id);
    if (!item || item.status === QUEUE_STATE.uploading) return;
    item.status = QUEUE_STATE.pending;
    await this.#persist(item);
    this.onUpdate(item);
    await this.pump();
  }

  /** 全部重试：失败项一起置回 pending 后只跑一轮 pump（逐项 retry 会重复触发 pump）。 */
  async retryAllErrors() {
    let touched = false;
    for (const item of this.items) {
      if (item.status === QUEUE_STATE.error) {
        item.status = QUEUE_STATE.pending;
        await this.#persist(item);
        touched = true;
      }
    }
    if (touched) this.onUpdate(null);
    await this.pump();
  }

  async remove(id) {
    const item = this.items.find((row) => row.id === id);
    if (item && item.status === QUEUE_STATE.uploading) return; // 在传的项不允许删，先等它出结果
    this.items = this.items.filter((row) => row.id !== id);
    await this.store.remove(id);
    this.onUpdate(null);
  }

  async clearDone() {
    const done = this.items.filter((row) => row.status === QUEUE_STATE.done);
    this.items = this.items.filter((row) => row.status !== QUEUE_STATE.done);
    for (const item of done) await this.store.remove(item.id);
    this.onUpdate(null);
  }

  /** 已完成记录只留最近 maxDone 条：它们是"传过什么"的回看，不是归档本身。 */
  async #pruneDone() {
    const done = this.items
      .filter((row) => row.status === QUEUE_STATE.done)
      .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    const stale = done.slice(this.maxDone);
    if (!stale.length) return;
    const staleIds = new Set(stale.map((row) => row.id));
    this.items = this.items.filter((row) => !staleIds.has(row.id));
    for (const item of stale) await this.store.remove(item.id);
  }
}
