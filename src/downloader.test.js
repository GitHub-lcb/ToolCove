import { describe, it, expect } from "vitest";
import {
  ITEM_STATE,
  DEFAULT_CONNS,
  MAX_CONNS,
  MIN_CONNS,
  applyProbe,
  applyProgress,
  clampConns,
  createItem,
  dedupeByFileName,
  fileNameFromUrl,
  formatBytes,
  formatEta,
  formatPercent,
  formatSpeed,
  hasActiveWork,
  joinDest,
  nextWaiting,
  normalizeDownloadUrl,
  parseUrlList,
  planParts,
  queueProgress,
  queueSpeed,
  resolveFileName,
  validateDest,
} from "./downloader.js";

describe("线程数", () => {
  it("夹在 1 到 32 之间，非法输入回落默认", () => {
    expect(clampConns(undefined)).toBe(DEFAULT_CONNS);
    expect(clampConns("abc")).toBe(DEFAULT_CONNS);
    expect(clampConns(0)).toBe(MIN_CONNS);
    expect(clampConns(-5)).toBe(MIN_CONNS);
    expect(clampConns(999)).toBe(MAX_CONNS);
    expect(clampConns(16)).toBe(16);
  });
});

describe("URL 列表解析", () => {
  it("逐行取出 http(s) 地址，去重且保序", () => {
    const text = ["https://a.com/1.bin", "http://b.com/2.bin", "https://a.com/1.bin"].join("\n");
    expect(parseUrlList(text)).toEqual(["https://a.com/1.bin", "http://b.com/2.bin"]);
  });

  it("剥掉常见的复制污染：引号、逗号、分号", () => {
    expect(parseUrlList('"https://a.com/x.bin",')).toEqual(["https://a.com/x.bin"]);
    expect(parseUrlList("`https://a.com/y.bin`;")).toEqual(["https://a.com/y.bin"]);
  });

  it("丢弃空行与非 URL 行，但保留行内 URL 后面的说明文字之前那段", () => {
    const text = ["", "   ", "随便一行说明", "  https://a.com/ok.bin  "].join("\n");
    expect(parseUrlList(text)).toEqual(["https://a.com/ok.bin"]);
  });

  it("从混杂文本里只认行首的 http 地址", () => {
    expect(parseUrlList("看这个 https://a.com/x.bin 很大")).toEqual([]);
    expect(parseUrlList("https://a.com/x.bin 16GB")).toEqual(["https://a.com/x.bin"]);
  });

  it("空输入返回空数组", () => {
    expect(parseUrlList("")).toEqual([]);
    expect(parseUrlList(null)).toEqual([]);
  });
});

describe("网页地址改写成下载地址", () => {
  it("HuggingFace 的 /blob/ 预览页改写成 /resolve/", () => {
    // 用户从浏览器地址栏复制到的就是 /blob/，那是 HTML 预览页，不改必然下不了
    expect(normalizeDownloadUrl("https://hf-mirror.com/a/b/blob/main/f.safetensors")).toBe(
      "https://hf-mirror.com/a/b/resolve/main/f.safetensors"
    );
  });

  it("保留 query（?download=1 之类不能丢）", () => {
    expect(normalizeDownloadUrl("https://huggingface.co/a/b/blob/main/f.bin?download=true")).toBe(
      "https://huggingface.co/a/b/resolve/main/f.bin?download=true"
    );
  });

  it("目录列表页 /tree/ 不乱改（猜不出是哪个文件，交给报错路径说明）", () => {
    const url = "https://huggingface.co/a/b/tree/main";
    expect(normalizeDownloadUrl(url)).toBe(url);
  });

  it("非 HF 地址与大小写变体都照原样处理", () => {
    expect(normalizeDownloadUrl("https://example.com/f.bin")).toBe("https://example.com/f.bin");
    expect(normalizeDownloadUrl("https://x.com/BLOB/main/f.bin")).toBe("https://x.com/resolve/main/f.bin");
    expect(normalizeDownloadUrl("")).toBe("");
  });

  it("入队时就已改写，列表里显示的是可用地址", () => {
    expect(parseUrlList("https://huggingface.co/a/b/blob/main/f.bin")).toEqual([
      "https://huggingface.co/a/b/resolve/main/f.bin",
    ]);
  });

  it("改写后再去重：同一文件的预览页与下载地址只留一条", () => {
    const list = parseUrlList(
      ["https://huggingface.co/a/b/blob/main/f.bin", "https://huggingface.co/a/b/resolve/main/f.bin"].join("\n")
    );
    expect(list).toHaveLength(1);
  });
});

describe("文件名推导", () => {
  it("取 URL 末段并去掉 query", () => {
    expect(fileNameFromUrl("https://a.com/dir/model.safetensors?download=1")).toBe("model.safetensors");
  });

  it("URL 根路径不能把域名当文件名", () => {
    expect(fileNameFromUrl("https://a.com/")).toBe("download.bin");
    expect(fileNameFromUrl("https://a.com")).toBe("download.bin");
  });

  it("末段带斜杠时取它前面那段", () => {
    expect(fileNameFromUrl("https://a.com/a/b/")).toBe("b");
  });

  it("解码百分号编码的中文名", () => {
    expect(fileNameFromUrl("https://a.com/%E6%A8%A1%E5%9E%8B.gguf")).toBe("模型.gguf");
  });

  it("剔除 Windows 非法字符", () => {
    expect(fileNameFromUrl("https://a.com/a%3Ab*c.bin")).toBe("abc.bin");
  });

  it("探测结果里的文件名优先于 URL 推导", () => {
    expect(resolveFileName({ fileName: "real.gguf" }, "https://a.com/wrong.bin")).toBe("real.gguf");
    expect(resolveFileName({ fileName: "  " }, "https://a.com/wrong.bin")).toBe("wrong.bin");
    expect(resolveFileName(null, "https://a.com/wrong.bin")).toBe("wrong.bin");
  });
});

describe("分片计划", () => {
  it("均分且首尾相接，总字节精确", () => {
    const parts = planParts(1000, 8);
    expect(parts).toHaveLength(8);
    expect(parts[0]).toEqual({ start: 0, end: 124, want: 125 });
    expect(parts[7]).toEqual({ start: 875, end: 999, want: 125 });
    expect(parts.reduce((sum, p) => sum + p.want, 0)).toBe(1000);
    for (let i = 1; i < parts.length; i += 1) {
      expect(parts[i].start).toBe(parts[i - 1].end + 1);
    }
  });

  it("线程数多于字节数时不产生空分片", () => {
    const parts = planParts(2, 8);
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => p.want > 0)).toBe(true);
  });

  it("总长为 0 返回空计划", () => {
    expect(planParts(0, 8)).toEqual([]);
    expect(planParts(null, 8)).toEqual([]);
  });
});

describe("格式化", () => {
  it("字节数按 1024 进制并保留合适小数", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(16.33 * 1024 ** 3)).toBe("16.3 GB");
    // 1.5 KB 不能被抹成 2 KB——那是在把真实进度说错
    expect(formatBytes(1536, 1)).toBe("1.5 KB");
    expect(formatBytes(1024, 0)).toBe("1 KB");
  });

  it("负数与非法值按 0 处理", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes("abc")).toBe("0 B");
  });

  it("速度带 /s 后缀", () => {
    expect(formatSpeed(0)).toBe("0 B/s");
    expect(formatSpeed(2 * 1024 * 1024)).toBe("2.0 MB/s");
  });

  it("百分比不到 100% 时保留一位小数", () => {
    expect(formatPercent(0, 1000)).toBe("0.0%");
    expect(formatPercent(500, 1000)).toBe("50.0%");
    expect(formatPercent(1000, 1000)).toBe("100%");
    expect(formatPercent(5, 0)).toBe("0%");
  });

  it("总量未知或速度为 0 时不编造剩余时间", () => {
    expect(formatEta(0, 0, 100)).toBe("");
    expect(formatEta(50, 100, 0)).toBe("");
    expect(formatEta(100, 100, 100)).toBe("");
  });

  it("剩余时间按秒/分/时/天递进", () => {
    expect(formatEta(0, 100, 10)).toBe("10s");
    expect(formatEta(0, 6000, 100)).toBe("1m");
    expect(formatEta(0, 360000, 100)).toBe("1h 0m");
    expect(formatEta(0, 86400 * 100 * 2, 100)).toBe("2d 0h");
  });
});

describe("队列项", () => {
  it("初始为等待态，用 URL 推导文件名", () => {
    const item = createItem("https://a.com/x.bin", 0, "D:\\models");
    expect(item.state).toBe(ITEM_STATE.waiting);
    expect(item.fileName).toBe("x.bin");
    expect(item.dest).toBe("D:\\models");
    expect(item.downloaded).toBe(0);
    expect(item.error).toBe("");
  });

  it("应用进度事件后进入运行态并吸收字节数", () => {
    const item = createItem("https://a.com/x.bin", 0, "D:\\models");
    const next = applyProgress(item, { downloaded: 500, total: 1000, speed: 100, conns: 16 });
    expect(next.state).toBe(ITEM_STATE.running);
    expect(next.downloaded).toBe(500);
    expect(next.speed).toBe(100);
    expect(next.conns).toBe(16);
    // 不可变：原对象不被改
    expect(item.downloaded).toBe(0);
    expect(item.state).toBe(ITEM_STATE.waiting);
  });

  it("应用探测结果后回填总长与真实文件名", () => {
    const item = createItem("https://a.com/wrong.bin", 0, "D:\\models");
    const next = applyProbe(item, { fileName: "real.gguf", total: 2048, ranges: true });
    expect(next.fileName).toBe("real.gguf");
    expect(next.total).toBe(2048);
    expect(next.ranges).toBe(true);
    expect(next.state).toBe(ITEM_STATE.waiting);
  });

  it("已完成的项不因重新探测被拉回等待态", () => {
    const done = { ...createItem("https://a.com/x.bin", 0, "D"), state: ITEM_STATE.done };
    expect(applyProbe(done, { total: 10 }).state).toBe(ITEM_STATE.done);
  });
});

describe("队列推进", () => {
  it("取第一个等待项", () => {
    const items = [
      { ...createItem("https://a.com/1", 0, "D"), state: ITEM_STATE.done },
      { ...createItem("https://a.com/2", 1, "D"), state: ITEM_STATE.waiting },
      { ...createItem("https://a.com/3", 2, "D"), state: ITEM_STATE.waiting },
    ];
    expect(nextWaiting(items).url).toBe("https://a.com/2");
    expect(nextWaiting([{ state: ITEM_STATE.done }])).toBeNull();
  });

  it("活跃判定包含运行中与等待中", () => {
    expect(hasActiveWork([{ state: ITEM_STATE.waiting }])).toBe(true);
    expect(hasActiveWork([{ state: ITEM_STATE.running }])).toBe(true);
    expect(hasActiveWork([{ state: ITEM_STATE.done }, { state: ITEM_STATE.error }])).toBe(false);
  });

  it("总进度按字节加权，不按项数平均", () => {
    const items = [
      { downloaded: 1000, total: 1000, state: ITEM_STATE.done, speed: 0 },
      { downloaded: 0, total: 9000, state: ITEM_STATE.waiting, speed: 0 },
    ];
    // 大文件没开始也不能让总进度显示 50%
    expect(queueProgress(items)).toEqual({ downloaded: 1000, total: 10000 });
  });

  it("速度只汇总运行中的项", () => {
    const items = [
      { state: ITEM_STATE.running, speed: 100 },
      { state: ITEM_STATE.running, speed: 50 },
      { state: ITEM_STATE.done, speed: 999 },
      { state: ITEM_STATE.waiting, speed: 999 },
    ];
    expect(queueSpeed(items)).toBe(150);
  });
});

describe("保存路径校验", () => {
  it("接受 Windows 绝对路径、UNC 与正斜杠路径", () => {
    expect(validateDest("D:\\models").ok).toBe(true);
    expect(validateDest("D:/models").ok).toBe(true);
    expect(validateDest("\\\\server\\share").ok).toBe(true);
    expect(validateDest("/tmp/models").ok).toBe(true);
  });

  it("拦下空、相对与含非法字符的路径", () => {
    expect(validateDest("").reason).toBe("empty");
    expect(validateDest("   ").reason).toBe("empty");
    expect(validateDest("models").reason).toBe("relative");
    expect(validateDest("D:\\mo<dels").reason).toBe("illegal");
  });

  it("文件名非法时也拦下", () => {
    expect(validateDest("D:\\models", "a:b.bin").reason).toBe("name");
    expect(validateDest("D:\\models", "ok.bin").ok).toBe(true);
  });

  it("拼接目标路径并去掉目录末尾斜杠", () => {
    expect(joinDest("D:\\models", "a.bin")).toBe("D:\\models\\a.bin");
    expect(joinDest("D:\\models\\", "a.bin")).toBe("D:\\models\\a.bin");
    expect(joinDest("", "a.bin")).toBe("a.bin");
  });
});

describe("批量去重", () => {
  it("同名文件只保留第一条，避免互相覆盖", () => {
    const items = [
      createItem("https://a.com/x.bin", 0, "D"),
      createItem("https://b.com/y.bin", 1, "D"),
      createItem("https://c.com/x.bin", 2, "D"),
    ];
    const kept = dedupeByFileName(items);
    expect(kept).toHaveLength(2);
    expect(kept[0].url).toBe("https://a.com/x.bin");
    expect(kept[1].url).toBe("https://b.com/y.bin");
  });

  it("大小写不同也算同名（Windows 文件系统不区分大小写）", () => {
    const items = [createItem("https://a.com/Model.BIN", 0, "D"), createItem("https://b.com/model.bin", 1, "D")];
    expect(dedupeByFileName(items)).toHaveLength(1);
  });
});
