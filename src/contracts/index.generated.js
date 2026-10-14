// ⚠️ 本文件由 scripts/gen-tool-registry.mjs 生成，请勿手改。
// 重新生成：node scripts/gen-tool-registry.mjs（或 npm run gen:tools）
//
// 为什么是生成物：新增工具只加一个目录（src/tools/<key>/），注册由脚本扫描得出——
// 两个人在不同分支各加一个工具时，不会争抢同一个登记点。
// 顺序 = 各契约的 order 字段（画廊展示顺序的单一真相源）。
import tool0 from "./convert.js";
import tool1 from "./table.js";
import tool2 from "./markdown.js";
import tool3 from "./xml.js";
import tool4 from "./diff.js";
import tool5 from "./schema.js";
import tool6 from "./time.js";
import tool7 from "./json.js";
import tool8 from "./network.js";
import tool9 from "./crypto.js";
import tool10 from "./file.js";
import tool11 from "./image.js";
import tool12 from "./photo.js";
import tool13 from "./screenshot.js";
import tool14 from "./disk.js";
import tool15 from "./generator.js";
import tool16 from "../tools/pdf/contract.js";
import tool17 from "./request.js";
import tool18 from "./downloader.js";
import tool19 from "./db.js";
import tool20 from "./chat.js";
import tool21 from "./checkin.js";
import tool22 from "./prompt.js";
import tool23 from "./netcapture.js";
import tool24 from "./label.js";
import tool25 from "./rail.js";
import tool26 from "./interview.js";

export const TOOL_CONTRACTS = Object.freeze([
  tool0,
  tool1,
  tool2,
  tool3,
  tool4,
  tool5,
  tool6,
  tool7,
  tool8,
  tool9,
  tool10,
  tool11,
  tool12,
  tool13,
  tool14,
  tool15,
  tool16,
  tool17,
  tool18,
  tool19,
  tool20,
  tool21,
  tool22,
  tool23,
  tool24,
  tool25,
  tool26,
]);

export const CONTRACT_BY_KEY = new Map(TOOL_CONTRACTS.map((contract) => [contract.key, contract]));
