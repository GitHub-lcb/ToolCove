# PDF 测试夹具

`pdfDecrypt.test.js` 用的真实加密样本。**不要手工编辑**，重新生成方式如下。

## 为什么用真实加密样本

JS 侧没有能生成加密 PDF 的库（pdf-lib 不支持加密），而「去加密」这条链路的价值就在于
能否处理真实文件 —— 用假样本测等于没测。这里的样本由 **pikepdf（qpdf 官方 Python 绑定）**
生成，因此它同时也是 qpdf-wasm 解密结果的参照实现。

## 生成方式

```bash
python -m venv tmp/pyvenv
tmp/pyvenv/Scripts/python.exe -m pip install pikepdf
tmp/pyvenv/Scripts/python.exe tmp/make-fixtures.py   # 脚本见 git 历史（一次性工具）
```

| 文件 | 加密方式 | 口令 | 用途 |
|------|----------|------|------|
| `base.pdf` | 未加密 | — | 对照：确认「未加密文件走这条路也不会坏」 |
| `owner-only.pdf` | AES-256（R=6）权限加密 | 用户口令为空 | 电子发票 / 银行回单那类：免密码打开但限制复制编辑 |
| `user-password.pdf` | AES-256（R=6） | 用户口令 `open123` | 验证「需要口令」与「口令错误」两条分支 |
| `owner-only-rc4.pdf` | RC4（R=3）权限加密 | 用户口令为空 | 兼容老式加密文件 |

四个文件合计约 5KB。
