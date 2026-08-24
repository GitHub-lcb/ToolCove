import Bowser from "bowser";

function ensureHttpUrl(input) {
  const value = String(input ?? "").trim();
  if (!value) throw new Error("请输入 URL");
  const hasProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
  const normalized = hasProtocol ? value : `https://${value}`;
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("URL 格式无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("仅支持 HTTP 或 HTTPS URL");
  }
  return { url, inferredProtocol: !hasProtocol };
}

export function parseUrl(input) {
  const { url, inferredProtocol } = ensureHttpUrl(input);
  return {
    href: url.href,
    origin: url.origin,
    protocol: url.protocol.slice(0, -1),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    hash: url.hash,
    params: Array.from(url.searchParams, ([key, value]) => ({ key, value })),
    inferredProtocol,
  };
}

export function rebuildUrl(parts, params = parts?.params || []) {
  const protocol = String(parts?.protocol || "https").replace(/:$/, "");
  if (protocol !== "http" && protocol !== "https") throw new Error("仅支持 HTTP 或 HTTPS URL");
  const hostname = String(parts?.hostname || "").trim();
  if (!hostname) throw new Error("URL 缺少主机名");
  const credentials = parts.username
    ? `${encodeURIComponent(parts.username)}${parts.password ? `:${encodeURIComponent(parts.password)}` : ""}@`
    : "";
  const port = parts.port ? `:${parts.port}` : "";
  const pathname = String(parts.pathname || "/").startsWith("/")
    ? String(parts.pathname || "/")
    : `/${parts.pathname}`;
  const url = new URL(`${protocol}://${credentials}${hostname}${port}${pathname}`);
  for (const item of params) {
    if (String(item?.key ?? "") !== "") url.searchParams.append(String(item.key), String(item.value ?? ""));
  }
  url.hash = String(parts.hash || "");
  return url.toString();
}

function ipv4ToNumber(value) {
  const chunks = String(value ?? "").trim().split(".");
  if (chunks.length !== 4 || chunks.some((chunk) => !/^\d{1,3}$/.test(chunk) || Number(chunk) > 255)) {
    throw new Error("请输入有效的 IPv4 地址");
  }
  return chunks.reduce((result, chunk) => ((result << 8) | Number(chunk)) >>> 0, 0);
}

function numberToIpv4(value) {
  const num = Number(value) >>> 0;
  return [24, 16, 8, 0].map((shift) => (num >>> shift) & 255).join(".");
}

function isPrivateIpv4(value) {
  return (
    (value >= ipv4ToNumber("10.0.0.0") && value <= ipv4ToNumber("10.255.255.255"))
    || (value >= ipv4ToNumber("172.16.0.0") && value <= ipv4ToNumber("172.31.255.255"))
    || (value >= ipv4ToNumber("192.168.0.0") && value <= ipv4ToNumber("192.168.255.255"))
  );
}

export function analyzeCidr(input) {
  const [ipText, prefixText = "32"] = String(input ?? "").trim().split("/");
  const ipNumber = ipv4ToNumber(ipText);
  if (!/^\d{1,2}$/.test(prefixText) || Number(prefixText) > 32) {
    throw new Error("CIDR 前缀必须是 0 到 32 的整数");
  }
  const prefix = Number(prefixText);
  const subnetMask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const wildcardMask = (~subnetMask) >>> 0;
  const network = (ipNumber & subnetMask) >>> 0;
  const broadcast = (network | wildcardMask) >>> 0;
  const totalAddresses = 2 ** (32 - prefix);
  const firstHost = prefix >= 31 ? network : network + 1;
  const lastHost = prefix >= 31 ? broadcast : broadcast - 1;
  return {
    ip: numberToIpv4(ipNumber),
    prefix,
    subnetMask: numberToIpv4(subnetMask),
    wildcardMask: numberToIpv4(wildcardMask),
    network: numberToIpv4(network),
    broadcast: numberToIpv4(broadcast),
    firstHost: numberToIpv4(firstHost),
    lastHost: numberToIpv4(lastHost),
    totalAddresses,
    usableHosts: prefix === 32 ? 1 : prefix === 31 ? 2 : Math.max(0, totalAddresses - 2),
    integer: ipNumber,
    binary: ipNumber.toString(2).padStart(32, "0").match(/.{8}/g).join("."),
    private: isPrivateIpv4(ipNumber),
  };
}

export function parseUserAgent(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { raw, browser: {}, os: {}, platform: {}, engine: {} };
  const parser = Bowser.getParser(raw);
  return {
    raw,
    browser: parser.getBrowser(),
    os: parser.getOS(),
    platform: parser.getPlatform(),
    engine: parser.getEngine(),
  };
}
