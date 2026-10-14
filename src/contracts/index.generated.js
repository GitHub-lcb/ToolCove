// ⚠️ 本文件由 scripts/gen-tool-registry.mjs 生成，请勿手改。
// 重新生成：node scripts/gen-tool-registry.mjs（或 npm run gen:tools）
//
// 为什么是生成物：新增工具只加一个目录（src/tools/<key>/），注册由脚本扫描得出——
// 两个人在不同分支各加一个工具时，不会争抢同一个登记点。
// 顺序 = 各契约的 order 字段（画廊展示顺序的单一真相源）。
import tool0 from "../tools/convert/contract.js";
import tool1 from "../tools/table/contract.js";
import tool2 from "../tools/markdown/contract.js";
import tool3 from "../tools/xml/contract.js";
import tool4 from "../tools/diff/contract.js";
import tool5 from "../tools/schema/contract.js";
import tool6 from "../tools/time/contract.js";
import tool7 from "../tools/json/contract.js";
import tool8 from "../tools/network/contract.js";
import tool9 from "../tools/crypto/contract.js";
import tool10 from "../tools/file/contract.js";
import tool11 from "../tools/image/contract.js";
import tool12 from "../tools/photo/contract.js";
import tool13 from "../tools/screenshot/contract.js";
import tool14 from "../tools/disk/contract.js";
import tool15 from "../tools/generator/contract.js";
import tool16 from "../tools/pdf/contract.js";
import tool17 from "../tools/request/contract.js";
import tool18 from "../tools/downloader/contract.js";
import tool19 from "../tools/db/contract.js";
import tool20 from "../tools/chat/contract.js";
import tool21 from "../tools/checkin/contract.js";
import tool22 from "../tools/prompt/contract.js";
import tool23 from "../tools/netcapture/contract.js";
import tool24 from "../tools/label/contract.js";
import tool25 from "../tools/rail/contract.js";
import tool26 from "../tools/interview/contract.js";

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
