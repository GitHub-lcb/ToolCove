// 浏览器端文件导出：以「下载」替代「写入用户选择的路径」。
// 仅在浏览器分支使用；桌面端仍由 Rust export_file/export_file_b64 落盘。
const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  gif: "image/gif",
  ico: "image/x-icon",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
  csv: "text/csv",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  sql: "application/sql",
};

export function fileNameFrom(path, fallback = "download") {
  const name = String(path || "").split(/[\\/]/).pop();
  return name && name.trim() ? name.trim() : fallback;
}

export function mimeFromName(name) {
  const ext = String(name || "").split(".").pop().toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

function triggerDownload(blob, name) {
  if (typeof document === "undefined") throw new Error("当前环境不支持下载");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadBlob(blob, name) {
  triggerDownload(blob, fileNameFrom(name, "download"));
}

export function downloadText(text, name, mime) {
  const resolved = fileNameFrom(name, "download.txt");
  triggerDownload(new Blob([String(text ?? "")], { type: mime || mimeFromName(resolved) }), resolved);
}

export function downloadBase64(base64, name) {
  const resolved = fileNameFrom(name, "download");
  const binary = atob(String(base64 || "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  triggerDownload(new Blob([bytes], { type: mimeFromName(resolved) }), resolved);
}
