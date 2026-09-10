// Agent 业务数据工具：让规划器能读写应用自己的数据（速记/问题/迭代/领域/池/发布），
// 而不是只有 json/file/db 这类通用能力。
//
// 返回体量是硬约束：runtime 对单次工具结果有上限（默认 32000 字符），超了整步失败。
// 所以 query 只给摘要（长文本截断、对象数组降级为条数），需要细节再 data.get。
import { KINDS, create, get, list, remove, update } from "../data/repository.js";

const KIND_ENUM = Object.freeze(Object.keys(KINDS));
const QUERY_LIMIT_MAX = 50;
const QUERY_FIELD_LIMIT = 400;
const QUERY_ARRAY_CAP = 20;
const GET_TOTAL_LIMIT = 24000;
const GET_FIELD_LIMIT = 8000;
const GET_ARRAY_CAP = 50;
const GET_DEPTH_MAX = 3;
const DRAFT_LIMIT = 16000;

// 每个类别的必填字段、可改字段白名单与枚举：模型给的 draft/patch 永不直接落盘，先过这里。
// images 等不同步的大字段刻意不在白名单内（云同步 v1 不带图片，见 sync/merge.js）。
// enums 与视图的取值表同源（问题类型/状态、迭代阶段）：写进未知取值会让视图渲染直接抛异常。
const KIND_META = Object.freeze({
  snippets: { required: ["title"], fields: ["title", "category", "content", "pinned"] },
  problems: {
    required: ["title"],
    fields: ["title", "type", "status", "tags", "note", "resolution"],
    enums: { type: ["online", "meeting", "temp", "other"], status: ["open", "done"] },
  },
  iterations: {
    required: ["title", "version"],
    fields: ["title", "version", "status", "releaseDate", "goal", "domainIds"],
    enums: { status: ["plan", "dev", "test", "pending", "live"] },
  },
  domains: { required: ["name"], fields: ["name", "note"] },
  pools: { required: ["domainId", "name"], fields: ["name", "note", "path"] },
  releases: { required: ["name"], fields: ["name", "codingProject"] },
});

const text = { type: "string", maxLength: 16000 };
const schema = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const cut = (s, n) => (s.length > n ? s.slice(0, n) : s);
const isPrimitive = (v) => v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** query 摘要：标量原样、长文本截断、字符串数组截断、对象数组（items/logs 等）降级为条数 */
function summarize(record) {
  const out = {};
  let truncated = false;
  for (const [key, value] of Object.entries(record || {})) {
    if (typeof value === "string") {
      const s = cut(value, QUERY_FIELD_LIMIT);
      truncated = truncated || s.length !== value.length;
      out[key] = s;
    } else if (isPrimitive(value)) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      if (value.every(isPrimitive)) {
        out[key] = value.slice(0, QUERY_ARRAY_CAP);
        truncated = truncated || out[key].length !== value.length;
      } else {
        out[`${key}Count`] = value.length;
      }
    } else {
      const s = JSON.stringify(value);
      out[key] = s.length > QUERY_FIELD_LIMIT ? cut(s, QUERY_FIELD_LIMIT) : value;
      truncated = truncated || s.length > QUERY_FIELD_LIMIT;
    }
  }
  if (truncated) out.truncated = true;
  return out;
}

/** get 整条返回；超过阈值才降级（限制放宽一档），保证「读一条完整记录」在正常体量下无损 */
function boundRecord(record) {
  if (JSON.stringify(record).length <= GET_TOTAL_LIMIT) return record;
  return { ...deepBound(record), truncated: true };
}

function deepBound(value, depth = 0) {
  if (typeof value === "string") return cut(value, GET_FIELD_LIMIT);
  if (isPrimitive(value)) return value;
  if (Array.isArray(value)) {
    if (depth >= GET_DEPTH_MAX) return `${value.length} 项（已省略）`;
    return value.slice(0, GET_ARRAY_CAP).map((v) => deepBound(v, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = deepBound(v, depth + 1);
  return out;
}

export function createDataTools() {
  return [
    {
      name: "data.query",
      description: "检索本地业务数据（kind：snippets 速记 / problems 问题 / iterations 迭代 / domains 领域 / pools 池 / releases 发布），支持关键词、标签、状态过滤，返回按更新时间倒序的 {total, items} 摘要",
      descriptionKey: "agent.toolDataQuery",
      risk: "read",
      retryable: false,
      inputSchema: schema(
        {
          kind: { type: "string", enum: KIND_ENUM },
          keyword: text,
          tag: text,
          status: text,
          ids: { type: "array", maxItems: QUERY_LIMIT_MAX, items: text },
          limit: { type: "integer", minimum: 1, maximum: QUERY_LIMIT_MAX },
        },
        ["kind"]
      ),
      execute: async ({ kind, keyword, tag, status, ids, limit = 20 }) => {
        const { total, items } = await list(kind, { keyword, tag, status, ids, limit: Math.min(limit, QUERY_LIMIT_MAX) });
        return { kind, total, items: items.map(summarize) };
      },
    },
    {
      name: "data.get",
      description: "按 id 读取一条完整的本地业务数据（先用 data.query 拿到 id；kind 同 data.query）",
      descriptionKey: "agent.toolDataGet",
      risk: "read",
      retryable: false,
      inputSchema: schema({ kind: { type: "string", enum: KIND_ENUM }, id: text }, ["kind", "id"]),
      execute: async ({ kind, id }) => {
        const record = await get(kind, id);
        if (!record) throw Error(`未找到记录：${kind}/${id}`);
        return boundRecord(record);
      },
    },
    {
      name: "data.create",
      description: "新建一条本地业务数据（kind 同 data.query）。draft 必填：snippets/problems 用 title，domains 用 name，pools 用 domainId+name，iterations 用 title+version，releases 用 name",
      descriptionKey: "agent.toolDataCreate",
      risk: "write",
      retryable: false,
      inputSchema: schema({ kind: { type: "string", enum: KIND_ENUM }, draft: { type: "object" } }, ["kind", "draft"]),
      execute: async ({ kind, draft }) => {
        const input = cleanDraft(draft, "draft");
        const missing = KIND_META[kind].required.filter((f) => input[f] == null || input[f] === "");
        if (missing.length) throw Error(`新建 ${kind} 缺少必填字段：${missing.join("、")}`);
        checkEnums(kind, input);
        const record = await create(kind, input, { source: "agent" });
        return { kind, id: record.id, record };
      },
    },
    {
      name: "data.update",
      description: `按 id 修改一条本地业务数据（kind 同 data.query）。可改字段：${fieldSummary()}`,
      descriptionKey: "agent.toolDataUpdate",
      risk: "write",
      retryable: false,
      inputSchema: schema({ kind: { type: "string", enum: KIND_ENUM }, id: text, patch: { type: "object" } }, ["kind", "id", "patch"]),
      execute: async ({ kind, id, patch }) => {
        const input = cleanDraft(patch, "patch");
        const allowed = KIND_META[kind].fields;
        const unknown = Object.keys(input).filter((k) => !allowed.includes(k));
        if (unknown.length) throw Error(`不可修改字段：${unknown.join("、")}（${kind} 允许：${allowed.join("、")}）`);
        if (!Object.keys(input).length) throw Error("patch 为空，没有要修改的字段");
        checkEnums(kind, input);
        const record = await update(kind, id, input, { fields: allowed, source: "agent" });
        return { kind, id, record };
      },
    },
    {
      name: "data.remove",
      description: "删除一条本地业务数据（速记/问题会同步删除到其他设备；不可恢复）。执行前必须由用户确认",
      descriptionKey: "agent.toolDataRemove",
      risk: "write",
      confirm: "always",
      retryable: false,
      inputSchema: schema({ kind: { type: "string", enum: KIND_ENUM }, id: text }, ["kind", "id"]),
      execute: async ({ kind, id }) => {
        await remove(kind, id, { source: "agent" });
        return { kind, id, removed: true };
      },
    },
  ];
}

const fieldSummary = () => KIND_ENUM.map((k) => `${k}→${KIND_META[k].fields.join("/")}`).join("；");

/** 枚举校验：视图的取值表直接用作索引（如 TYPES[p.type].cls），写进未知取值会让界面渲染抛异常 */
function checkEnums(kind, input) {
  const enums = KIND_META[kind].enums;
  if (!enums) return;
  for (const [field, allowed] of Object.entries(enums)) {
    const value = input[field];
    if (value != null && !allowed.includes(value)) {
      throw Error(`${kind}.${field} 只能是：${allowed.join("、")}（收到：${String(value)}）`);
    }
  }
}

/** draft/patch 归一：拒绝非对象、拒绝超长、剥离 id 与时间戳（id 由仓库生成，避免与既有记录撞 id） */
function cleanDraft(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${label} 必须是字段对象`);
  const input = { ...value };
  delete input.id;
  delete input.createdAt;
  delete input.updatedAt;
  const size = JSON.stringify(input).length;
  if (size > DRAFT_LIMIT) throw Error(`${label} 过大（${size} 字符，上限 ${DRAFT_LIMIT}）`);
  return input;
}
