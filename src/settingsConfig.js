// 设置页辅助逻辑。平台集成配置函数不随 ToolCove 迁移，此处仅保留侧边栏模块隐藏列表归一。

// 遥测配置归一（旧数据/缺字段自动补默认值）：enabled 默认 false、prompted 默认 false、installId 非法置 null
// installId 仅限 1..=128 字符字符串，其他一律置 null（由调用方按需补生成）
export function normalizeTelemetry(raw) {
  const t = raw && typeof raw === "object" ? raw : {};
  const enabled = t.enabled === true;
  const prompted = t.prompted === true;
  let installId = typeof t.installId === "string" ? t.installId : null;
  if (installId !== null && (installId.length === 0 || installId.length > 128)) installId = null;
  return { enabled, prompted, installId };
}

// 云同步配置归一（旧数据/缺字段补默认）：默认全关；serverUrl 仅接受 http(s) 且长度受限
export function normalizeSync(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  let serverUrl = typeof s.serverUrl === "string" ? s.serverUrl.trim() : "";
  if (serverUrl && !/^https?:\/\//.test(serverUrl)) serverUrl = "";
  if (serverUrl.length > 512) serverUrl = serverUrl.slice(0, 512);
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  return {
    enabled: s.enabled === true,
    serverUrl,
    collectionId: str(s.collectionId, 64),
    deviceName: str(s.deviceName, 64),
    deviceId: str(s.deviceId, 64),
    salt: str(s.salt, 64),
    keyCipher: str(s.keyCipher, 1024),
    tokenCipher: str(s.tokenCipher, 1024),
    cursor: num(s.cursor),
    lastPushedAt: num(s.lastPushedAt),
    lastSyncAt: num(s.lastSyncAt),
    status: s.status === "revoked" ? "revoked" : "idle",
  };
}

// 侧边栏模块展示/隐藏：只保留当前存在的模块 key，去重且保持顺序
export function normalizeHiddenModules(allKeys, hidden) {
  const keys = Array.isArray(allKeys) ? allKeys.filter((k) => typeof k === "string") : [];
  const list = Array.isArray(hidden) ? hidden : [];
  const seen = new Set();
  const result = [];
  for (const key of list) {
    if (!keys.includes(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}
