// 云同步合并逻辑（纯函数，可单测）：
// - LWW：信封内 ts（updatedAt）大者胜；同值按 deviceId 字典序（大者胜），双端确定性一致。
// - 墓碑：remote tombstone 且其裁决时间不早于本地 → 删除。
// - 问题记录 images 字段：远端同步负载不含图片（v1），应用时保留本地既有图片不产生悬空引用。
// - 本模块不做加解密（engine 先解密信封再调用）。

/** 归一化远端条目（容错缺字段） */
export function normalizeRemoteItem(raw) {
  const id = raw && typeof raw.id === "string" ? raw.id : "";
  return {
    id,
    updatedAt: Number(raw && raw.updatedAt) || 0,
    data: raw && typeof raw.data === "string" ? raw.data : "",
    tombstone: !!(raw && raw.tombstone),
    seq: Number(raw && raw.seq) || 0,
  };
}

/** 解密后的信封对象归一 */
export function normalizeEnvelope(env) {
  return {
    deviceId: env && typeof env.deviceId === "string" ? env.deviceId : "",
    ts: Number(env && env.ts) || 0,
    record: env && typeof env.record === "object" ? env.record : null,
  };
}

/**
 * LWW 裁决：a 胜出返回 1，b 胜出返回 -1，相同返回 0。
 * 双方以 (ts, deviceId) 全序比较，任何双端计算同一结果。
 */
export function lwwCompare(aTs, aDevice, bTs, bDevice) {
  if (aTs > bTs) return 1;
  if (aTs < bTs) return -1;
  if (aDevice === bDevice) return 0;
  return aDevice > bDevice ? 1 : -1;
}

/**
 * 合并远端条目到本地记录列表。
 * @param {Array} localRecords 本地记录数组（含 id/updatedAt/images 等原始字段）
 * @param {Array} remoteItems 已解密条目 [{updatedAt, tombstone, envelope:{deviceId,ts,record}}]
 * @param {string} localDeviceId 本机设备 ID
 * @returns {{ records: Array, ops: Array<{type, record}> }}
 */
export function mergeRemote(localRecords, remoteItems, localDeviceId) {
  const byId = new Map();
  for (const r of localRecords || []) {
    if (r && typeof r.id === "string") byId.set(r.id, r);
  }
  const ops = [];
  for (const item of remoteItems || []) {
    const env = normalizeEnvelope(item.envelope);
    const recordId = env.record && env.record.id;
    if (!recordId || typeof recordId !== "string") continue;
    const local = byId.get(recordId);
    if (item.tombstone) {
      if (local) {
        const localTs = Number(local.updatedAt) || 0;
        // 远端墓碑（updatedAt 即墓碑时间）不早于本地版本才删除；更旧则本地为准
        if (lwwCompare(item.updatedAt, "", localTs, localDeviceId) >= 0) {
          byId.delete(recordId);
          ops.push({ type: "delete", record: { id: recordId, updatedAt: item.updatedAt } });
        }
      }
      continue;
    }
    const localTs = local ? Number(local.updatedAt) || 0 : -1;
    const remoteTs = env.ts;
    if (!local) {
      const record = keepLocalImages(env.record, null);
      byId.set(record.id, record);
      ops.push({ type: "add", record });
      continue;
    }
    if (lwwCompare(remoteTs, env.deviceId, localTs, localDeviceId) > 0) {
      const record = keepLocalImages(env.record, local);
      byId.set(record.id, record);
      ops.push({ type: "update", record });
    }
  }
  return { records: [...byId.values()], ops };
}

/** 应用远端记录时保留本地已有 images（问题截图 v1 不同步，避免悬空引用） */
function keepLocalImages(remoteRecord, localRecord) {
  const record = { ...remoteRecord };
  if (Array.isArray(localRecord && localRecord.images) && (!Array.isArray(record.images) || record.images.length === 0)) {
    record.images = localRecord.images;
  } else if (!Array.isArray(record.images)) {
    record.images = [];
  }
  return record;
}

/**
 * 收集需要推送的本地记录（含墓碑），供 engine 加密上传。
 */
export function collectPushes(localRecords, lastPushedAt = 0, tombstones = []) {
  const out = [];
  for (const r of localRecords || []) {
    const ts = Number(r.updatedAt) || 0;
    if (ts > lastPushedAt) out.push({ record: r, updatedAt: ts });
  }
  for (const t of tombstones || []) {
    if (Number(t.updatedAt) > lastPushedAt) out.push({ tombstone: true, id: t.id, updatedAt: Number(t.updatedAt) || 0 });
  }
  return out;
}

/** 墓碑清理（30 天过期） */
export function pruneTombstones(tombstones, nowTs, ttlMs = 30 * 24 * 3600 * 1000) {
  const out = {};
  for (const [id, ts] of Object.entries(tombstones || {})) {
    if (nowTs - ts < ttlMs) out[id] = ts;
  }
  return out;
}
