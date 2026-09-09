import { emptyUsage, addUsage as accumulateUsage } from './quota.js';

const isSensitive = key => /^(password|passwd|pwd|token|accesstoken|refreshtoken|secret|apikey|authorization|proxyauthorization|cookie|setcookie|clientsecret)$/i.test(String(key).replace(/[-_ ]/g, ''));
const MARK = '[REDACTED]';
const PAIR = /\b(password|passwd|pwd|(?:access|refresh)[_-]?token|token|secret|api[-_ ]?key|client[-_ ]?secret)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s&,;}]+)/gi;

// 尽力识别常见凭据格式；不能识别所有无标签自由文本中的机密。
export function sanitizeRun(value) {
  const secrets = new Set();
  const collect = (v, depth = 0) => {
    if (depth > 30) return;
    if (typeof v === 'string') {
      if (/^[\[{]/.test(v.trim())) { try { collect(JSON.parse(v), depth + 1); } catch {} }
      for (const m of v.matchAll(PAIR)) {
        const secret = m[2].replace(/^["']|["']$/g, '');
        if (secret && secret !== MARK) secrets.add(secret);
      }
    } else if (v && typeof v === 'object') {
      if (isSensitive(v.key) && typeof v.value === 'string' && v.value) secrets.add(v.value);
      for (const [k, item] of Object.entries(v)) {
        if (isSensitive(k) && typeof item === 'string' && item) secrets.add(item);
        collect(item, depth + 1);
      }
    }
  };
  collect(value);
  const clean = (v, depth = 0) => {
    if (depth > 30) return '[DEPTH LIMIT]';
    if (typeof v === 'string') {
      if (/^[\[{]/.test(v.trim())) {
        try { return JSON.stringify(clean(JSON.parse(v), depth + 1)); } catch {}
      }
      let s = v.replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, `$1 ${MARK}`)
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${MARK}@`)
        .replace(PAIR, (_, key) => `${key}=${MARK}`)
        .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, MARK);
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
        // 单字符机密只按键名处理，避免破坏所有普通文字。
        if (secret.length >= 4 && secret !== MARK) s = s.split(secret).join(MARK);
      }
      return s;
    }
    if (Array.isArray(v)) return v.map(item => clean(item, depth + 1));
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(v).map(([key, item]) => [key,
      isSensitive(key) || (key === 'value' && isSensitive(v.key)) ? MARK : clean(item, depth + 1),
    ]));
  };
  return clean(value);
}

export function createRun(input) {
  return { id: crypto.randomUUID(), input: String(input || ''), status: 'pending', steps: [], history: [], usage: emptyUsage(), createdAt: Date.now(), updatedAt: Date.now() };
}
// 把一次模型调用的用量就地累加到 run 上；持久化由调用方负责。
// 旧的已存 run 没有 usage 字段，accumulateUsage 会按空值补齐，因此不需要数据迁移。
export function addUsage(run, delta) {
  if (!run || typeof run !== 'object') return null;
  run.usage = accumulateUsage(run.usage, delta);
  run.updatedAt = Date.now();
  return run.usage;
}
export function appendStep(run, step) {
  const value = { ...sanitizeRun(step), eventId: crypto.randomUUID(), ts: Date.now() };
  run.steps.push(value);
  run.status = step.status || run.status;
  run.updatedAt = Date.now();
  return value;
}
export function canResume(run, registry) {
  if (!run?.input || JSON.stringify(sanitizeRun(run)).includes(MARK)) return false;
  return (run.history || []).every(h => h.action?.type !== 'tool_call' || ['read', 'transform'].includes(registry.get(h.action.tool)?.risk));
}
