// 数据库工具包的 Agent 动作实现：**只有 execute，不含元数据**。
// 元数据在同一包的 ./contract.js。
//
// 只读守卫 isReadOnlySql 与本包纯逻辑 ./logic.js 同源（连接元数据 / SQL 校验那一份实现）。
// 查询经**中立原生 IPC 桥** src/nativeInvoke.js 调用原生 db_query_readonly。
// 装配点：../../agent/executors.js 把本默认导出合并进 BUILTIN_TOOL_IMPLS。
import { desktopInvoke } from "../../nativeInvoke.js";
import { isReadOnlySql } from "./logic.js";

export default {
  "db.query_readonly": {
    execute: ({ connId, sql }) => {
      if (!isReadOnlySql(sql)) throw Error("只读查询工具拒绝执行写入 SQL");
      return desktopInvoke("db_query_readonly", { connId, sql });
    },
  },
};
