// 交付队列的持久化存储。
//
// 独立成库（toolcove-photo）而不是塞进 kv.js 的 "toolcove" 库：那个库的版本号是 1，
// 为照片队列升版本会牵动所有既有用户的打开路径；新能力独立建库零风险。
// 队列记录里带 Blob——IndexedDB 是浏览器里唯一能持久化二进制大对象的内置存储。
const DB_NAME = "toolcove-photo";
const STORE = "queue";
const DB_VERSION = 1;

function memoryStore(map = new Map()) {
  return {
    kind: "memory",
    async list() {
      return [...map.values()];
    },
    async put(item) {
      map.set(item.id, item);
    },
    async remove(id) {
      map.delete(id);
    },
    async clear() {
      map.clear();
    },
  };
}

/** 测试与无 IndexedDB 环境（Node）用的内存实现。 */
export function createMemoryStore() {
  return memoryStore();
}

function idbStore(db) {
  const tx = (mode, run) =>
    new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("indexedDB 操作失败"));
    });
  return {
    kind: "indexeddb",
    list: () => tx("readonly", (s) => s.getAll()),
    put: (item) => tx("readwrite", (s) => s.put(item)).then(() => undefined),
    remove: (id) => tx("readwrite", (s) => s.delete(id)).then(() => undefined),
    clear: () => tx("readwrite", (s) => s.clear()).then(() => undefined),
  };
}

function openIdb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexedDB open failed"));
    request.onblocked = () => reject(new Error("indexedDB blocked"));
  });
}

/** 运行时入口：优先 IndexedDB，失败退化内存（宁可本次会话能传，也不要整页不可用）。 */
export async function createPhotoStore() {
  try {
    return idbStore(await openIdb());
  } catch {
    return memoryStore();
  }
}
