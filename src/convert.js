const encoder = new TextEncoder();

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} 不是有效的 UTF-8 文本`);
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(input) {
  let text = String(input ?? "").trim().replace(/\s+/g, "");
  if (!text) return new Uint8Array();
  text = text.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    throw new Error("请输入有效的 Base64 内容");
  }
  const unpadded = text.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) throw new Error("请输入有效的 Base64 内容");
  text = unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4);
  try {
    const binary = atob(text);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new Error("请输入有效的 Base64 内容");
  }
}

export function encodeBase64(input, urlSafe = false) {
  const encoded = bytesToBase64(encoder.encode(String(input ?? "")));
  return urlSafe ? encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoded;
}

export function decodeBase64(input) {
  return decodeUtf8(base64ToBytes(input), "Base64 解码结果");
}

export function encodeUrl(input) {
  return encodeURIComponent(String(input ?? ""));
}

export function decodeUrl(input) {
  try {
    return decodeURIComponent(String(input ?? "").replace(/\+/g, " "));
  } catch {
    throw new Error("请输入有效的 URL 编码内容");
  }
}

export function encodeUnicode(input) {
  return Array.from(String(input ?? ""), (char) => {
    if (/^[\x00-\x7f]$/.test(char)) return char;
    let result = "";
    for (let i = 0; i < char.length; i += 1) {
      result += `\\u${char.charCodeAt(i).toString(16).padStart(4, "0")}`;
    }
    return result;
  }).join("");
}

export function decodeUnicode(input) {
  const text = String(input ?? "");
  let result = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "\\") {
      result += text[i];
      continue;
    }
    const kind = text[++i];
    if (kind === undefined) throw new Error("Unicode 转义末尾缺少内容");
    if (kind === "u") {
      const hex = text.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("请输入有效的 Unicode 转义，如 \\u4e2d");
      result += String.fromCharCode(parseInt(hex, 16));
      i += 4;
      continue;
    }
    const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0", "\\": "\\", '"': '"', "'": "'" };
    if (!(kind in escapes)) throw new Error(`不支持的 Unicode 转义：\\${kind}`);
    result += escapes[kind];
  }
  return result;
}

export function encodeHex(input) {
  return [...encoder.encode(String(input ?? ""))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

export function decodeHex(input) {
  const text = String(input ?? "").trim().replace(/[\s-]+/g, "");
  if (!text) return "";
  if (!/^[0-9a-fA-F]+$/.test(text)) throw new Error("请输入有效的 Hex 内容");
  if (text.length % 2 !== 0) throw new Error("Hex 字符数必须为偶数");
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < text.length; i += 2) bytes[i / 2] = parseInt(text.slice(i, i + 2), 16);
  return decodeUtf8(bytes, "Hex 解码结果");
}

export function encodeJsonString(input) {
  return JSON.stringify(String(input ?? "")).slice(1, -1);
}

export function decodeJsonString(input) {
  try {
    return JSON.parse(`"${String(input ?? "")}"`);
  } catch {
    throw new Error("请输入有效的 JSON 字符串转义内容");
  }
}

function parseJwtPart(part, label) {
  let text;
  try {
    text = decodeBase64(part);
  } catch {
    throw new Error(`JWT ${label} 不是有效的 Base64URL`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JWT ${label} 不是有效的 JSON`);
  }
}

export function parseJwt(input) {
  const token = String(input ?? "").trim().replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) throw new Error("JWT 必须包含由英文句点分隔的三段内容");
  return {
    header: parseJwtPart(parts[0], "Header"),
    payload: parseJwtPart(parts[1], "Payload"),
    signature: parts[2],
    hasSignature: Boolean(parts[2]),
  };
}
