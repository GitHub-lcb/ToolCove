// SDK 组件下载器的单测。
//
// 这一层只有两个函数，但它们各自踩过一次坑，而且**两次都是静默失败**：
//   1) 直接取段里第一个 <url> → 下到 Linux 包；解包照样成功，
//      直到用 adb 或 aapt2 时才报「不是有效的 Win32 应用程序」。
//   2) 清单里的 <url> 是相对文件名，直接 fetch 只会得到 Invalid URL。
// 两者都不会在安装阶段报错，所以值得锁住。

import { describe, it, expect } from "vitest";
import { findPackage, resolveUrl } from "./fetch-sdk.mjs";

/** 取自真实清单（repository2-3.xml）的片段结构：多平台包按 linux → macosx → windows 排。 */
const MULTI_PLATFORM = `
  <remotePackage path="platform-tools">
    <type-details xsi:type="generic:genericDetailsType"/>
    <revision><major>37</major><minor>0</minor><micro>1</micro></revision>
    <archives>
      <archive>
        <complete><size>9054187</size><checksum>aaa</checksum></complete>
        <host-os>linux</host-os>
        <url>platform-tools_r37.0.1-linux.zip</url>
      </archive>
      <archive>
        <complete><size>16110554</size><checksum>bbb</checksum></complete>
        <host-os>macosx</host-os>
        <url>platform-tools_r37.0.1-darwin.zip</url>
      </archive>
      <archive>
        <complete><size>8044989</size><checksum>ccc</checksum></complete>
        <host-os>windows</host-os>
        <url>platform-tools_r37.0.1-win.zip</url>
      </archive>
    </archives>
  </remotePackage>
  <remotePackage path="unrelated">
    <archives><archive><url>wrong.zip</url></archive></archives>
  </remotePackage>
`;

/** 平台无关的包（platforms）没有 host-os，只有 base 一个 archive。 */
const PLATFORM_AGNOSTIC = `
  <remotePackage path="platforms;android-35">
    <archives>
      <archive>
        <complete><size>64273788</size><checksum>ddd</checksum></complete>
        <url>platform-35_r02.zip</url>
      </archive>
    </archives>
  </remotePackage>
`;

/**
 * 真实清单里最容易踩的一处：**同一个 path 出现两次**。
 * 旧 channel 里也有一个 `build-tools;35.0.0`，指向 Android 4.0.3 时代的工具包。
 * 只按 path 找第一处就会命中它——包能下能解，只是里面是 15 年前的 aapt2。
 */
const DUPLICATE_PATH = `
  <remotePackage path="build-tools;35.0.0">
    <revision><major>15</major></revision>
    <archives>
      <archive>
        <host-os>windows</host-os>
        <url>build-tools_r15-windows.zip</url>
      </archive>
    </archives>
  </remotePackage>
  <remotePackage path="build-tools;35.0.0">
    <revision><major>35</major></revision>
    <archives>
      <archive>
        <host-os>windows</host-os>
        <url>build-tools_r35_windows.zip</url>
      </archive>
    </archives>
  </remotePackage>
`;

describe("从清单里挑组件包", () => {
  it("多平台包里挑 windows，不挑排在最前面的 linux", () => {
    expect(findPackage(MULTI_PLATFORM, "platform-tools").url).toBe("platform-tools_r37.0.1-win.zip");
  });

  it("只在自己那个 remotePackage 段里找，不会串到下一个包", () => {
    const picked = findPackage(MULTI_PLATFORM, "platform-tools");
    expect(picked.url).not.toContain("wrong");
  });

  it("没有 host-os 的包用 base archive", () => {
    expect(findPackage(PLATFORM_AGNOSTIC, "platforms;android-35").url).toBe("platform-35_r02.zip");
  });

  it("包不存在时明确报错，不返回空值", () => {
    expect(() => findPackage(MULTI_PLATFORM, "build-tools;99.0.0")).toThrow(/清单里没有/);
  });
});

describe("同名旧 channel 条目", () => {
  it("不带 urlHint 时会命中最前面那个（旧版），这正是坑本身", () => {
    expect(findPackage(DUPLICATE_PATH, "build-tools;35.0.0").url).toBe("build-tools_r15-windows.zip");
  });

  it("带 urlHint 时挑出真正的 35 版，而不是 15 版", () => {
    const hint = /^build-tools_r35_windows\.zip$/;
    expect(findPackage(DUPLICATE_PATH, "build-tools;35.0.0", hint).url).toBe("build-tools_r35_windows.zip");
  });

  it("urlHint 一个都匹配不上时明确报错，并列出候选，不静默退化", () => {
    const hint = /^build-tools_r99_windows\.zip$/;
    expect(() => findPackage(DUPLICATE_PATH, "build-tools;35.0.0", hint)).toThrow(/没有一个匹配/);
    // 报错信息里要能看见候选项，否则排查时只能猜
    expect(() => findPackage(DUPLICATE_PATH, "build-tools;35.0.0", hint)).toThrow(/build-tools_r15-windows\.zip/);
  });
});

describe("补全下载地址", () => {
  it("相对文件名补成 Google 仓库的绝对地址", () => {
    expect(resolveUrl("platform-tools_r37.0.1-win.zip")).toBe(
      "https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip",
    );
  });

  it("已经是绝对地址就原样用（清单格式换过，两种都见过）", () => {
    const absolute = "https://dl.google.com/android/repository/platform-35_r02.zip";
    expect(resolveUrl(absolute)).toBe(absolute);
  });
});
