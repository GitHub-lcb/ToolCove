// spill 存储的运行期单例。
//
// 为什么单独一个文件：这份实例被三处共用（runtime 落盘、spill.read 工具读回、session 清空），
// 而工具实现层（executors.js）会牵出 luxon / js-yaml 等重依赖——把它挂在实现层里，
// 会让「只想用一下 spill 清空」的视图把整套工具实现也拖进首屏。放这里零依赖。
// 测试注入 globalThis.__tcSpillStore 即可替换成内存实现。
import { createSpillStore } from './spillStore.js';

export const spillStore = globalThis.__tcSpillStore || createSpillStore();
