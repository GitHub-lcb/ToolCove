import { ref } from "vue";

// 列表拖拽排序：按元素 id 在源数组中重排（兼容过滤视图），落定后回调持久化
export function useDragSort(getArray, onSorted) {
  const dragId = ref(null); // 正在拖动的元素 id
  const overId = ref(null); // 当前悬停目标 id（用于插入位置高亮）

  function onDragStart(e, id) {
    dragId.value = id;
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", id);
    } catch {}
  }
  function onDragOver(e, id) {
    if (!dragId.value || dragId.value === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    overId.value = id;
  }
  function onDrop(e, id) {
    e.preventDefault();
    const arr = getArray();
    const from = arr.findIndex((x) => x.id === dragId.value);
    const to = arr.findIndex((x) => x.id === id);
    dragId.value = null;
    overId.value = null;
    if (from < 0 || to < 0 || from === to) return;
    const [item] = arr.splice(from, 1);
    arr.splice(to, 0, item);
    if (onSorted) onSorted();
  }
  function onDragEnd() {
    dragId.value = null;
    overId.value = null;
  }
  return { dragId, overId, onDragStart, onDragOver, onDrop, onDragEnd };
}
