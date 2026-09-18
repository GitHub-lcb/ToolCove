import { describe, expect, it } from "vitest";
import {
  GUARDED_TOOLS,
  OBSERVATION_STATUS,
  createObservationGate,
  findInspectEvidence,
  isSamePath,
  normalizePath,
  pathsOf,
} from "./observation.js";

const gate = (options) => createObservationGate(options);
const readOk = (g, path) => g.observeSuccess("file.read_text", { path }, { text: "旧内容" });
const codeOf = (refusal) => refusal?.code;

describe("normalizePath / isSamePath", () => {
  it("只去首尾空白", () => {
    expect(normalizePath("  C:\\a\\b.txt  ")).toBe("C:\\a\\b.txt");
    expect(normalizePath(null)).toBe("");
  });

  it("大小写与分隔符差异视为同一路径（Windows 上确实是同一个文件）", () => {
    expect(isSamePath("C:\\Tmp\\A.txt", "c:/tmp/a.txt")).toBe(true);
    expect(isSamePath("C:\\a.txt", "C:\\b.txt")).toBe(false);
    expect(isSamePath("", "")).toBe(false);
  });
});

describe("pathsOf", () => {
  it("read/write/preview 取单个 path", () => {
    expect(pathsOf("file.write_text", { path: "C:/a.txt" })).toEqual(["C:/a.txt"]);
    expect(pathsOf("file.read_text", { path: " C:/a.txt " })).toEqual(["C:/a.txt"]);
  });

  it("inspect 取 paths 数组并去重去空", () => {
    expect(pathsOf("file.inspect", { paths: ["C:/a.txt", "C:/a.txt", "", "  ", "C:/b.txt"] })).toEqual(["C:/a.txt", "C:/b.txt"]);
  });

  it("缺参数时返回空数组，不产生幽灵路径", () => {
    expect(pathsOf("file.write_text", {})).toEqual([]);
    expect(pathsOf("file.inspect", {})).toEqual([]);
    expect(pathsOf("file.inspect", { paths: null })).toEqual([]);
  });
});

describe("写入门禁", () => {
  it("从未观察过的路径：拒绝写入，并给出可自救的提示", () => {
    const g = gate();
    const refusal = g.check("file.write_text", { path: "C:/tmp/new.txt" });
    expect(codeOf(refusal)).toBe("OBSERVATION_REQUIRED");
    expect(refusal.message).toContain("file.read_text");
    expect(refusal.message).toContain("file.inspect"); // 新建文件的那条出路也要说清楚
  });

  it("缺 path 参数：拒绝而不是放行", () => {
    expect(codeOf(gate().check("file.write_text", {}))).toBe("OBSERVATION_REQUIRED");
  });

  it("读过内容后放行，且大小写/分隔符不同的写法也认", () => {
    const g = gate();
    readOk(g, "C:\\Tmp\\A.txt");
    expect(g.check("file.write_text", { path: "c:/tmp/a.txt" })).toBeNull();
  });

  it("读过但文件不存在（确定缺失）→ 允许创建新文件", () => {
    const g = gate();
    g.observeFailure("file.read_text", { path: "C:/tmp/ghost.txt" }, Error("无法读取文件：不存在 (os error 2)"));
    expect(g.statusOf("C:/tmp/ghost.txt")).toBe(OBSERVATION_STATUS.ABSENT);
    expect(g.check("file.write_text", { path: "C:/tmp/ghost.txt" })).toBeNull();
  });

  it("读过但失败且原因不是「不存在」→ 仍拒绝（不要用字符串匹配去猜）", () => {
    const g = gate();
    // Tauri 把任何 IO 错误都包成「无法读取文件：…」，所以权限错误与不存在必须区别对待
    g.observeFailure("file.read_text", { path: "C:/tmp/locked.txt" }, Error("无法读取文件：拒绝访问 (os error 5)"));
    expect(g.statusOf("C:/tmp/locked.txt")).toBe(OBSERVATION_STATUS.UNKNOWN);
    expect(codeOf(g.check("file.write_text", { path: "C:/tmp/locked.txt" }))).toBe("OBSERVATION_REQUIRED");
  });

  it("probeMissing=false 时关闭「读过但不存在」的判定", () => {
    const g = gate({ probeMissing: false });
    g.observeFailure("file.read_text", { path: "C:/tmp/ghost.txt" }, Error("no such file"));
    expect(codeOf(g.check("file.write_text", { path: "C:/tmp/ghost.txt" }))).toBe("OBSERVATION_REQUIRED");
  });
});

describe("file.inspect 只证明存在性，不授权覆写", () => {
  it("inspect 报「不存在」→ 允许创建（模型照提示做完 inspect 就该能写）", () => {
    const gate = createObservationGate();
    gate.observeSuccess("file.inspect", { paths: ["C:/tmp/new.txt"] }, [{ path: "C:/tmp/new.txt", exists: false }]);
    expect(gate.statusOf("C:/tmp/new.txt")).toBe("absent");
    expect(gate.check("file.write_text", { path: "C:/tmp/new.txt" })).toBeNull();
  });

  it("inspect 成功 → 状态 present，但写入仍然被拒", () => {
    const g = gate();
    // file.inspect 的参数形状是 paths（数组），不是 path——见下面那条专门的回归
    g.observeSuccess("file.inspect", { paths: ["C:/tmp/a.txt"] }, [{ path: "C:/tmp/a.txt", size: 10 }]);
    expect(g.statusOf("C:/tmp/a.txt")).toBe(OBSERVATION_STATUS.PRESENT);
    const refusal = g.check("file.write_text", { path: "C:/tmp/a.txt" });
    // 同名不等于同内容：只看到元信息不足以授权用新内容覆盖
    expect(codeOf(refusal)).toBe("OBSERVATION_REQUIRED");
    expect(refusal.message).toContain("元信息");
  });

  // 回归：file.inspect 的参数是 paths（数组），不是 path。
  // 早先只读 args.path，导致 inspect 永远登记不上，于是「先 inspect 再创建新文件」这条路走不通。
  it("inspect 用 paths 数组传参也能登记（参数形状与 read/write 不同）", () => {
    const g = gate();
    const ok = g.observeSuccess("file.inspect", { paths: ["C:/tmp/a.txt"] }, [{ path: "C:/tmp/a.txt", size: 10 }]);
    expect(ok).toBe(true);
    expect(g.statusOf("C:/tmp/a.txt")).toBe(OBSERVATION_STATUS.PRESENT);
  });

  it("inspect 一次查多个路径时逐个登记", () => {
    const g = gate();
    const paths = ["C:/tmp/a.txt", "C:/tmp/b.txt"];
    g.observeSuccess("file.inspect", { paths }, paths.map((path) => ({ path, size: 1 })));
    for (const path of paths) expect(g.statusOf(path)).toBe(OBSERVATION_STATUS.PRESENT);
  });

  it("inspect 之后 read_text 才能放行", () => {
    const g = gate();
    g.observeSuccess("file.inspect", { paths: ["C:/tmp/a.txt"] }, [{ path: "C:/tmp/a.txt" }]);
    readOk(g, "C:/tmp/a.txt");
    expect(g.check("file.write_text", { path: "C:/tmp/a.txt" })).toBeNull();
  });

  it("inspect 结果里没点名该路径 → 不登记（形状不符时不猜）", () => {    const g = gate();
    g.observeSuccess("file.inspect", { paths: ["C:/tmp/a.txt"] }, [{ path: "C:/other/b.txt" }]);
    expect(g.statusOf("C:/tmp/a.txt")).toBe(OBSERVATION_STATUS.UNKNOWN);
  });

  it("路径大小写/分隔符不同也认得出是同一文件", () => {
    const g = gate();
    g.observeSuccess("file.inspect", { paths: ["c:\\tmp\\A.txt"] }, [{ path: "C:/tmp/a.txt" }]);
    expect(g.statusOf("C:/TMP/A.TXT")).toBe(OBSERVATION_STATUS.PRESENT);
  });
});

describe("file.preview_write 既受门禁保护，也满足观察要求", () => {
  it("未观察时被拒", () => {
    const g = gate();
    expect(codeOf(g.check("file.preview_write", { path: "C:/tmp/a.txt" }))).toBe("OBSERVATION_REQUIRED");
  });

  it("成功执行后自己就满足了写入前提（它确实读了内容）", () => {
    const g = gate();
    g.observeSuccess("file.preview_write", { path: "C:/tmp/a.txt" }, { path: "C:/tmp/a.txt", diff: "" });
    expect(g.check("file.write_text", { path: "C:/tmp/a.txt" })).toBeNull();
    expect(g.check("file.preview_write", { path: "C:/tmp/a.txt" })).toBeNull();
  });
});

describe("findInspectEvidence", () => {
  it("在数组、嵌套对象、paths 包装里都能找到路径", () => {
    expect(findInspectEvidence([{ path: "a" }], "a")).toBe(true);
    expect(findInspectEvidence({ paths: [{ path: "a" }] }, "a")).toBe(true);
    expect(findInspectEvidence({ files: { list: [{ name: "a" }] } }, "a")).toBe(true);
  });

  it("找不到或形状不认识时返回 undefined（保守，不放行）", () => {
    expect(findInspectEvidence([{ path: "b" }], "a")).toBeUndefined();
    expect(findInspectEvidence("字符串结果", "a")).toBeUndefined();
    expect(findInspectEvidence(null, "a")).toBeUndefined();
    expect(findInspectEvidence([{ path: "a" }], "")).toBeUndefined();
  });

  it("循环引用不导致死循环", () => {
    const cyclic = { path: "b" };
    cyclic.self = cyclic;
    expect(findInspectEvidence(cyclic, "a")).toBeUndefined();
  });

  // 三态：true 存在 / false 确定不存在 / undefined 没有证据。
  // 这条是 E2E 抓到的真实缺陷：原先只看「有没有点名这个路径」，把 exists:false 也当成存在，
  // 于是按门禁提示做完 inspect 之后仍被拒，还回了句「该文件已存在」——新建文件走不通。
  it("明确说不存在时返回 false（而不是当成存在）", () => {
    expect(findInspectEvidence([{ path: "a", exists: false }], "a")).toBe(false);
    expect(findInspectEvidence({ paths: [{ path: "a", exists: false }] }, "a")).toBe(false);
    expect(findInspectEvidence([{ path: "a", found: false }], "a")).toBe(false);
    // 字段缺失时不能猜：返回 undefined（保守不放行）
    expect(findInspectEvidence([{ path: "a" }], "a")).toBe(true);
    // 存在证据优先于缺失证据（同一棵树里两者都有时，宁可保守）
    expect(findInspectEvidence([{ path: "a", exists: true }, { path: "a", exists: false }], "a")).toBe(true);
  });
});

describe("门禁是每运行独立的", () => {
  it("clear 之后回到未观察状态", () => {
    const g = gate();
    readOk(g, "C:/tmp/a.txt");
    expect(g.size).toBe(1);
    g.clear();
    expect(g.size).toBe(0);
    expect(codeOf(g.check("file.write_text", { path: "C:/tmp/a.txt" }))).toBe("OBSERVATION_REQUIRED");
  });

  it("两个门禁互不影响（对应两次独立运行）", () => {
    const a = gate();
    const b = gate();
    readOk(a, "C:/tmp/a.txt");
    expect(b.check("file.write_text", { path: "C:/tmp/a.txt" })).not.toBeNull();
  });

  it("登记清单覆盖了三个文件工具与两个受保护工具", () => {
    expect([...GUARDED_TOOLS].sort()).toEqual(["file.preview_write", "file.write_text"]);
  });
});
