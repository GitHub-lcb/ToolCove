// 加密与校验工具契约：UI 元数据 + Agent 动作声明，单一真相源（聚合见 index.js）。
import { schema, str, text } from "../../contracts/kit.js";

export default {
  key: "crypto",
  order: 100,
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolCrypto",
    icon: "shield",
    category: "development",
    descKey: "toolbox.registry.toolCryptoDesc",
    keywordsKey: "toolbox.registry.kwCrypto",
    ready: true,
  },
  actions: [
    {
      name: "crypto.hash",
      description: "计算文本的哈希摘要（MD5 / SHA-1 / SHA-256 / SHA-384 / SHA-512）",
      descriptionKey: "agent.toolCryptoHash",
      toolKey: "crypto",
      risk: "transform",
      retryable: false,
      inputSchema: schema(
        { text, algorithm: { type: "string", enum: ["MD5", "SHA-1", "SHA-256", "SHA-384", "SHA-512"] }, output: { type: "string", enum: ["hex", "base64"] } },
        ["text"]
      ),
    },
    {
      name: "crypto.hmac",
      description: "用密钥计算 HMAC 消息签名",
      descriptionKey: "agent.toolCryptoHmac",
      toolKey: "crypto",
      risk: "transform",
      retryable: false,
      inputSchema: schema(
        { text, secret: str(1024), algorithm: { type: "string", enum: ["SHA-1", "SHA-256", "SHA-384", "SHA-512"] }, output: { type: "string", enum: ["hex", "base64"] } },
        ["text", "secret"]
      ),
    },
    {
      name: "crypto.password",
      description: "生成强随机密码，可选长度与字符集",
      descriptionKey: "agent.toolCryptoPassword",
      toolKey: "crypto",
      risk: "transform",
      retryable: false,
      inputSchema: schema({
        length: { type: "integer", minimum: 4, maximum: 256 },
        uppercase: { type: "boolean" },
        lowercase: { type: "boolean" },
        numbers: { type: "boolean" },
        symbols: { type: "boolean" },
        excludeAmbiguous: { type: "boolean" },
      }),
    },
  ],
};
