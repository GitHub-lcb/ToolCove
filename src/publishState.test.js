// publishState.js 单测：本地发布记录（lastRelease）到行角标/进度的推导
import { describe, it, expect } from "vitest";
import { releaseBadge, releaseDetail, currentStepKey, doneStepsCount, RELEASE_STEPS } from "./publishState.js";

function makeRelease(status, doneKeys = []) {
  return {
    startedAt: 1,
    steps: RELEASE_STEPS.map((s) => ({ key: s.key, label: s.label, done: doneKeys.includes(s.key), at: doneKeys.includes(s.key) ? 2 : 0 })),
    status,
    finishedAt: status === "doing" ? 0 : 3,
  };
}

describe("releaseBadge", () => {
  it("无发布记录返回 null（调用方补 idle）", () => {
    expect(releaseBadge({ name: "x" })).toBeNull();
    expect(releaseBadge(null)).toBeNull();
  });

  it("进行中 -> deploying", () => {
    expect(releaseBadge({ lastRelease: makeRelease("doing") })).toBe("deploying");
  });

  it("已完成 -> success", () => {
    expect(releaseBadge({ lastRelease: makeRelease("done", ["pack", "upload", "release", "verify"]) })).toBe("success");
  });

  it("放弃/失败 -> failed", () => {
    expect(releaseBadge({ lastRelease: makeRelease("failed", ["pack"]) })).toBe("failed");
  });
});

describe("currentStepKey", () => {
  it("无记录或已结束返回 null", () => {
    expect(currentStepKey(null)).toBeNull();
    expect(currentStepKey(makeRelease("done", ["pack", "upload", "release", "verify"]))).toBeNull();
    expect(currentStepKey(makeRelease("failed", ["pack"]))).toBeNull();
  });

  it("进行中返回第一个未完成步骤", () => {
    expect(currentStepKey(makeRelease("doing"))).toBe("pack");
    expect(currentStepKey(makeRelease("doing", ["pack"]))).toBe("upload");
    expect(currentStepKey(makeRelease("doing", ["pack", "upload", "release"]))).toBe("verify");
  });

  it("进行中但全部完成（异常数据）返回 null", () => {
    expect(currentStepKey(makeRelease("doing", ["pack", "upload", "release", "verify"]))).toBeNull();
  });
});

describe("doneStepsCount / releaseDetail", () => {
  it("统计已完成步骤数", () => {
    expect(doneStepsCount(null)).toBe(0);
    expect(doneStepsCount(makeRelease("doing", ["pack", "upload"]))).toBe(2);
  });

  it("进行中显示进度，结束后显示结果", () => {
    expect(releaseDetail({})).toBe("");
    expect(releaseDetail({ lastRelease: makeRelease("doing", ["pack"]) })).toBe("1/4 步完成");
    expect(releaseDetail({ lastRelease: makeRelease("done", ["pack", "upload", "release", "verify"]) })).toBe("已发布");
    expect(releaseDetail({ lastRelease: makeRelease("failed", ["pack"]) })).toBe("发布失败");
  });
});
