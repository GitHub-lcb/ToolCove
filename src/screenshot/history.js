// 标注操作栈：撤销/重做只挪游标，不丢数据。
// push 会截断「撤销后再画」的重做分支（常规编辑器语义）；
// 生效列表是 ops[0..cursor)，渲染方只画这一截。

export function createHistory(limit = 300) {
  let ops = [];
  let cursor = 0;

  return {
    /** 当前生效的操作（渲染这份） */
    active() {
      return ops.slice(0, cursor);
    },
    get canUndo() {
      return cursor > 0;
    },
    get canRedo() {
      return cursor < ops.length;
    },
    get size() {
      return ops.length;
    },
    push(op) {
      ops = ops.slice(0, cursor);
      ops.push(op);
      if (ops.length > limit) ops.shift();
      cursor = ops.length;
      return ops.slice(0, cursor);
    },
    /** 撤销：返回撤销后的生效列表（无可撤销时原样） */
    undo() {
      if (cursor > 0) cursor -= 1;
      return ops.slice(0, cursor);
    },
    /** 重做：返回重做后的生效列表 */
    redo() {
      if (cursor < ops.length) cursor += 1;
      return ops.slice(0, cursor);
    },
    clear() {
      ops = [];
      cursor = 0;
    },
  };
}
