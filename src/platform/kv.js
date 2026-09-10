// 浏览器端键值存储：优先 IndexedDB（容量大、可存结构化数据），退化 localStorage，最后内存。
// 桌面端不使用本模块，数据仍走 Rust load_data/save_data 落 <应用数据目录>。
const DB_NAME = "toolcove";
const STORE = "kv";
const DB_VERSION = 1;
const LS_PREFIX = "tc:";

const memory = new Map();
let backendPromise = null;

function openIdb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexedDB open failed"));
    request.onblocked = () => reject(new Error("indexedDB blocked"));
  });
}

function idbBackend(db) {
  const tx = (mode, run) =>
    new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  return {
    get: (key) => tx("readonly", (s) => s.get(key)),
    set: (key, value) => tx("readwrite", (s) => s.put(value, key)).then(() => undefined),
    del: (key) => tx("readwrite", (s) => s.delete(key)).then(() => undefined),
    keys: () => tx("readonly", (s) => s.getAllKeys()),
  };
}

function localStorageBackend() {
  // Node 无 localStorage；Safari 隐私模式等场景 setItem 会抛异常，需探测。
  if (typeof localStorage === "undefined") return null;
  try {
    localStorage.setItem(LS_PREFIX + "__probe", "1");
    localStorage.removeItem(LS_PREFIX + "__probe");
  } catch {
    return null;
  }
  const read = (key) => {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (raw === null) return undefined;
    return JSON.parse(raw);
  };
  return {
    get: async (key) => read(key),
    set: async (key, value) => {
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    },
    del: async (key) => {
      localStorage.removeItem(LS_PREFIX + key);
    },
    keys: async () => {
      const out = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(LS_PREFIX)) out.push(key.slice(LS_PREFIX.length));
      }
      return out;
    },
  };
}

function memoryBackend() {
  return {
    get: async (key) => (memory.has(key) ? memory.get(key) : undefined),
    set: async (key, value) => {
      memory.set(key, value);
    },
    del: async (key) => {
      memory.delete(key);
    },
    keys: async () => [...memory.keys()],
  };
}

async function backend() {
  if (!backendPromise) {
    backendPromise = (async () => {
      try {
        return idbBackend(await openIdb());
      } catch {
        return localStorageBackend() || memoryBackend();
      }
    })();
  }
  return backendPromise;
}

/** 读取值；不存在返回 undefined（与 Rust load_data 返回空数组的约定由调用方决定）。 */
export async function kvGet(key) {
  const store = await backend();
  const value = await store.get(String(key));
  // IndexedDB 缺失键返回 undefined；localStorage 后端同样归一化为 undefined
  return value === undefined ? undefined : value;
}

export async function kvSet(key, value) {
  const store = await backend();
  await store.set(String(key), value);
}

export async function kvDelete(key) {
  const store = await backend();
  await store.del(String(key));
}

export async function kvKeys() {
  const store = await backend();
  return store.keys();
}
