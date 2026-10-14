// XML 工具契约：UI 元数据 + Agent 动作声明，单一真相源（聚合见 index.js）。
import { schema, text } from "./kit.js";

export default {
  key: "xml",
  scope: "both",
  ui: {
    labelKey: "toolbox.registry.toolXml",
    icon: "layers",
    category: "data",
    descKey: "toolbox.registry.toolXmlDesc",
    keywordsKey: "toolbox.registry.kwXml",
    ready: true,
  },
  actions: [
    {
      name: "xml.format",
      description: "格式化 XML 报文（缩进）；报文不合法时抛出带行列位置的错误",
      descriptionKey: "agent.toolXmlFormat",
      toolKey: "xml",
      risk: "transform",
      retryable: false,
      inputSchema: schema({ text, indent: { type: "integer", minimum: 0, maximum: 8 } }, ["text"]),
    },
    {
      name: "xml.to_json",
      description: "XML 报文转 JSON：属性带 @ 前缀、文本进 #text、同名重复元素成数组",
      descriptionKey: "agent.toolXmlToJson",
      toolKey: "xml",
      risk: "transform",
      retryable: false,
      inputSchema: schema({ text, alwaysArray: { type: "boolean" } }, ["text"]),
    },
    {
      name: "xml.validate",
      description: "校验 XML 良构性，返回错误码与行列位置；不合法也不抛异常，适合先诊断再修",
      descriptionKey: "agent.toolXmlValidate",
      toolKey: "xml",
      risk: "transform",
      retryable: false,
      inputSchema: schema({ text }, ["text"]),
    },
  ],
};
