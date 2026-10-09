// 截图三块界面（工具页 / 遮罩页 / 贴图窗）里的 i18n 键是字面量，缺一个就会把
// "screenshot.xxx" 直接显示给用户。遮罩页与贴图窗在 Node 下只能渲染空壳（onMounted
// 才取帧），文案断言覆盖不到，所以这里用一份键清单直接卡两个语言字典。
// 直读 JSON（不经过 i18n.global）：en-US 是懒加载包，测试里还没加载。
import { describe, expect, it } from "vitest";
import zh from "../i18n/zh-CN.json";
import en from "../i18n/en-US.json";

const TOOL_PAGE_KEYS = [
  "subtitle",
  "actionNow",
  "actionHint",
  "beginToast",
  "hotkeySection",
  "hotkeyCapture",
  "hotkeyPin",
  "hotkeyActive",
  "hotkeyOccupied",
  "hotkeyOff",
  "recordHint",
  "hotkeyRestore",
  "hotkeyGlobalHint",
  "hotkeySaved",
  "guideTitle",
  "guideCapture",
  "guideAnnotate",
  "guideConfirm",
  "guideEsc",
  "keyCopy",
  "keySave",
  "keyPin",
  "keyUndo",
  "keyRedo",
  "keyNudge",
  "keyCancel",
  "pinTitle",
  "pinGuide1",
  "pinGuide2",
  "pinGuide3",
];

const OVERLAY_KEYS = [
  "toolRect",
  "toolEllipse",
  "toolArrow",
  "toolPen",
  "toolMarker",
  "toolText",
  "toolMosaic",
  "undo",
  "redo",
  "copy",
  "save",
  "pin",
  "copyTip",
  "saveTip",
  "pinTip",
  "cancelTip",
  "customColor",
  "lineWidth",
  "textPlaceholder",
  "hint",
];

const PIN_KEYS = ["menuCopy", "menuSaveAs", "menuResetZoom", "menuClose"];

// Rust 侧系统通知文案（lib.rs 的 localized_text 直读字典）
const NATIVE_KEYS = ["notifyTitle", "captureFail", "noClipboardImage"];

const SCREENSHOT_KEYS = [...TOOL_PAGE_KEYS, ...OVERLAY_KEYS, ...PIN_KEYS, ...NATIVE_KEYS];

const DICTS = [
  ["zh-CN", zh],
  ["en-US", en],
];

describe("截图 i18n 键清单", () => {
  it("两种语言都齐，且都是非空字符串", () => {
    for (const [locale, dict] of DICTS) {
      expect(dict.screenshot, `${locale} 缺 screenshot 段`).toBeTruthy();
      for (const key of SCREENSHOT_KEYS) {
        expect(typeof dict.screenshot[key], `${locale}.screenshot.${key}`).toBe("string");
        expect(String(dict.screenshot[key]).trim().length, `${locale}.screenshot.${key} 为空`).toBeGreaterThan(0);
      }
    }
  });

  it("两语言的键集合完全一致（多出的键也是漏翻译的信号）", () => {
    expect(Object.keys(en.screenshot).sort()).toEqual(Object.keys(zh.screenshot).sort());
  });

  it("captureFail 带 {err} 占位，Rust 通知替换它才有位置放原因", () => {
    for (const [locale, dict] of DICTS) {
      expect(dict.screenshot.captureFail, locale).toContain("{err}");
    }
  });

  it("注册表与手机端引用的键都存在", () => {
    for (const [locale, dict] of DICTS) {
      for (const key of ["toolScreenshot", "toolScreenshotDesc"]) {
        expect(typeof dict.toolbox.registry[key], `${locale}.${key}`).toBe("string");
      }
      expect(Array.isArray(dict.toolbox.registry.kwScreenshot), `${locale} kwScreenshot`).toBe(true);
      expect(dict.toolbox.registry.kwScreenshot.length, `${locale} kwScreenshot 为空`).toBeGreaterThan(0);
      expect(String(dict.mobile.noteScreenshot || "").trim().length, `${locale} noteScreenshot`).toBeGreaterThan(0);
    }
  });
});
