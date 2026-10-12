# 已修复：提示词工具图片预览 E2E

日期：2026-10-12 · 状态：**已修复**

## 原现象

`e2e/specs/67-prompt-tool.spec.js` 有 2 条用例失败：

```
expect '.pm-card[data-role$=".png"] img' toHaveAttribute("src", /^data:image\/png;base64,/)
实际值： "C:\media\p20261012-162824-66jv.png"
```

## 根因（两处，都在 E2E 基建，不在产品代码）

### 1. 替身不忠于真机

`e2e/helpers.js` 的桌面替身写成：

```js
convertFileSrc: (p) => p,      // ← 返回裸路径
```

而**真实 Tauri 的 `convertFileSrc` 返回 WebView 真正能加载的 URL**（asset 协议，
形如 `http://asset.localhost/<编码后的绝对路径>`）。替身返回裸路径，
于是 `<img src>` 拿到 `C:\media\xxx.png` —— 浏览器不报错、也不加载，只是静默裂图。

### 2. 断言写错了分支的前提

```
await expect(page.locator('[data-role="gen-result"] img'))
  .toHaveAttribute("src", /^data:image\/png;base64,/);
```

`src/platform/image.js:19` 的 `imageSrc()` 是**按平台分流**的：

```js
if (isDesktop) return fileAssetUrl(await invoke("image_file_path", { name }));  // asset 协议
return `data:${...};base64,${await invoke("load_image", { name })}`;              // 浏览器/手机
```

桌面端走 asset 协议，**从来不是** base64。base64 是浏览器与手机端落 IndexedDB 时的降级路径。
这两条断言在桌面形态下**必然**失败——它们假定 img 走的是 base64 分支。

## 修法

**替身改为忠于真机**（`e2e/helpers.js`）：

```js
convertFileSrc: (p) => {
  const path = String(p).replace(/\\/g, "/").replace(/^\/+/, "");
  return `http://asset.localhost/${path}`;
},
```

**断言改为断言平台差异本身**（`e2e/specs/67-prompt-tool.spec.js`）：

```js
// 桌面端图片走 asset 协议，不是 base64 data URL——
// base64 是浏览器/手机端落 IndexedDB 时的降级路径。
// 断言"拿到 asset.localhost 的 URL"比断言某个具体字符串更能说明代码走对了分支。
await expect(page.locator('[data-role="gen-result"] img'))
  .toHaveAttribute("src", /^http:\/\/asset\.localhost\//);
```

## 为什么这样修

- **不动产品代码**：`imageSrc()` 的分流是正确的——桌面端把图片交给 WebView 的 asset 协议，
  比 base64 整个文件更省内存、渲染也更快。需要改的是测试基建，不是它。
- **断言写意图**：`/^http:\/\/asset\.localhost\//` 比 `toBe("http://asset.localhost/C:/media/...")`
  更稳（不绑定路径编码细节），同时仍能真正区分"走了桌面分支"与"走了浏览器分支"。

## 验证

```
npx playwright test --project=chromium e2e/specs/67-prompt-tool.spec.js
  → 15 passed
```

此前基线（`git stash` 回滚验证）：3 failed / 12 passed。
现在 15 passed，无失败。