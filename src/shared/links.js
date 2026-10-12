// 平台链接与状态的**纯解析**（不发起任何请求）。
//
// 子任务 / bug 行内会贴 Coding 这类平台的链接，界面需要就地显示事项编号并按状态上色。
// 刻意只做结构解析：不校验可达性、不联网——联网的部分在 platform/ 与 checkin/ 那边。
// 从 shared.js 拆出来是因为它和日期/工时毫无关系，混在一起会让人以为"通用"就该什么都装。

// 从输入提取事项编号：优先完整链接（issues/NNNN），兜底纯数字/短编号
// 输入："https://team.coding.net/p/xx/backlog/issues/123/detail" -> "#123"
export function extractCode(input) {
  const s = (input || "").trim();
  if (!s) return "";
  const m = s.match(/issues\/(\d+)/) || s.match(/#?(\d{3,})/);
  return m ? "#" + m[1] : "";
}

// 解析平台链接：返回 { projectName, issueCode }；无法解析返回 null
// 仅做结构解析（/p/项目名/ + issues|bugs/NNNN），不校验链接可达性
export function parseIssueUrl(url) {
  const s = (url || "").trim();
  if (!s) return null;
  const proj = s.match(/\/p\/([^/]+)/);
  const code = s.match(/\/issues\/(\d+)/) || s.match(/\/bugs?\/(\d+)/) || s.match(/#?(\d{3,})/);
  if (!code) return null;
  return {
    projectName: proj ? proj[1] : "",
    issueCode: Number(code[1]),
  };
}

// bug 状态归类：平台原始状态名/类型 -> 展示色调（纯函数，可单测）
// tone ∈ "done"(绿) | "active"(蓝) | "pending"(琥珀) | "unknown"(灰)
// 关闭类判定以类型 COMPLETED 为准（与子任务 done 口径一致），名称关键词仅兜底
const BUG_TONE_WORDS = {
  done: ["已完成", "已关闭", "已拒绝", "已取消", "不再修复", "completed", "closed", "resolved"],
  active: ["处理中", "进行中", "开发中", "测试中", "验证中", "修复中", "processing", "doing", "developing", "testing"],
  pending: ["待处理", "待修复", "待验证", "未开始", "新建", "打开", "pending", "open", "todo"],
};

export function bugStatusInfo(statusName, statusType) {
  if (statusType === "COMPLETED") return { tone: "done" };
  const name = String(statusName || "").toLowerCase().trim();
  if (!name) return { tone: "unknown" };
  for (const [tone, words] of Object.entries(BUG_TONE_WORDS)) {
    if (words.some((w) => name.includes(w))) return { tone };
  }
  return { tone: "unknown" };
}
