// 工具契约聚合：27 个工具的唯一真相源——每个工具一个文件，同时声明
//   ui      画廊/搜索/窗口所需的元数据（投影给 toolboxTools.js）
//   actions Agent 可调用动作的声明（名称/描述/风险分级/参数 Schema，投影给 agent/catalog.js）
//   agentExempt  刻意不接 Agent 的理由（与 actions 二选一，准入测试强制）
//
// 准入规则（README「工具准入」一节的执行形态）：新工具如果 Agent 调不到，
// 它要么是这里的 agentExempt 刻意例外，要么就是没做完——contracts.test.js 把这条变成红灯。
//
// 分层约束：本目录所有文件必须是纯数据（只能互相导入或导入 kit.js），
// 首屏同步读取、手机端对齐测试用原生 Node ESM 直接 import——实现层的重依赖
// 永远走 agent/executors.js 按需装配，不许漏进这里（importBoundaries.test.js 守着）。
import convert from "./convert.js";
import table from "./table.js";
import markdown from "./markdown.js";
import xml from "./xml.js";
import diff from "./diff.js";
import schemaTool from "./schema.js";
import time from "./time.js";
import json from "./json.js";
import network from "./network.js";
import crypto from "./crypto.js";
import file from "./file.js";
import image from "./image.js";
import photo from "./photo.js";
import screenshot from "./screenshot.js";
import disk from "./disk.js";
import pdf from "./pdf.js";
import generator from "./generator.js";
import request from "./request.js";
import downloader from "./downloader.js";
import db from "./db.js";
import chat from "./chat.js";
import checkin from "./checkin.js";
import prompt from "./prompt.js";
import netcapture from "./netcapture.js";
import label from "./label.js";
import rail from "./rail.js";
import interview from "./interview.js";

// 顺序即画廊展示顺序（与 TOOLBOX_TOOLS 历史顺序一致，不要随手调整）。
export const TOOL_CONTRACTS = Object.freeze([
  convert,
  table,
  markdown,
  xml,
  diff,
  schemaTool,
  time,
  json,
  network,
  crypto,
  file,
  image,
  photo,
  screenshot,
  disk,
  generator,
  pdf,
  request,
  downloader,
  db,
  chat,
  checkin,
  prompt,
  netcapture,
  label,
  rail,
  interview,
]);

export const CONTRACT_BY_KEY = new Map(TOOL_CONTRACTS.map((contract) => [contract.key, contract]));
