// PNG 字节与 base64 / Blob 的互转：
// Rust ↔ 前端走 base64 字符串（与既有 save_image/load_image 的约定一致），
// 页面内显示走 Blob URL，避免超长 data: URI 拖慢渲染。

/** Uint8Array → base64（分块，避免 apply 参数上限） */
export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** base64 → Uint8Array */
export function base64ToBytes(b64) {
  const binary = atob(String(b64 || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 字节 → 对象 URL（调用方负责 revoke） */
export function bytesToBlobUrl(bytes, type = "image/png") {
  return URL.createObjectURL(new Blob([bytes], { type }));
}

/** 画布 → base64 PNG（导出用） */
export async function canvasToBase64(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("导出图片失败");
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}
