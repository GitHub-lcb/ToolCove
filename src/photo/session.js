// 照片会话：配置的加密存取 + 上传队列装配。
//
// 手机视图与桌面（浏览器形态）视图共用这一份——"两套界面各写一遍加密存取"那种重复，
// 迟早会在某一端漂移（比如忘了给 accessKey 解密、或设备 id 生成规则不一致）。
//
// 无 Vue 依赖：纯 async 函数，视图各自管自己的响应式状态。
import { decryptValue, encryptValue } from "../secure.js";
import { loadToolbox, saveToolboxNow } from "../toolboxStore.js";
import { normalizePhotoConfig } from "./config.js";
import { generateDeviceId } from "./keys.js";
import { createPhotoStore } from "./idb.js";
import { PhotoQueue } from "./queue.js";
import { putPhoto } from "./upload.js";

/** 读配置：密文凭据解密还原；设备 id 缺失时生成一个并使用（后续保存会持久化）。 */
export async function loadPhotoConfig() {
  const saved = await loadToolbox("photo", null);
  let config = normalizePhotoConfig(saved);
  if (saved && typeof saved === "object") {
    const accessKey = await decryptValue(String(saved.accessKey || "")).catch(() => "");
    const secretKey = await decryptValue(String(saved.secretKey || "")).catch(() => "");
    config = normalizePhotoConfig({ ...saved, accessKey, secretKey });
  }
  if (!/^[0-9a-f]{6}$/.test(config.deviceId)) config.deviceId = generateDeviceId();
  return config;
}

/** 写配置：凭据加密后落盘（桌面 DPAPI / 安卓 Keystore；网页形态为本地存储明文，界面已如实告知）。 */
export async function savePhotoConfig(config) {
  const cfg = normalizePhotoConfig(config);
  await saveToolboxNow("photo", {
    ...cfg,
    accessKey: await encryptValue(cfg.accessKey),
    secretKey: await encryptValue(cfg.secretKey),
  });
  return cfg;
}

/** 默认上传器：按 provider 分派（S3 签名 PUT / 七牛表单直传 / WebDAV PUT）。抽成具名函数——
 * `a || ({...}) => {}` 这种写法 eslint 与 babel 解析器都不接受（对象解构参数的箭头函数不能直接跟在 || 右侧）。 */
function defaultUploader({ item, config }) {
  if (!item.blob) throw new Error("本地照片数据已丢失，请重新拍摄或选择");
  return putPhoto({ config, key: item.key, body: item.blob, contentType: item.type || "" });
}

/** 建队列：持久存储 + 默认上传器。 */
export async function createUploadQueue({ onUpdate = () => {}, uploader } = {}) {
  const store = await createPhotoStore();
  const queue = new PhotoQueue({
    store,
    uploader: uploader || defaultUploader,
    onUpdate,
  });
  await queue.init();
  return queue;
}

/** 文件输入 → 队列入参。capturedAt 用文件的 lastModified（相机/相册给的拍摄时间）。 */
export function filesFromInput(fileList) {
  return [...(fileList || [])].map((file) => ({
    blob: file,
    name: file.name,
    type: file.type,
    size: file.size,
    capturedAt: file.lastModified || Date.now(),
  }));
}
