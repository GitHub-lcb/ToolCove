// 面试题库 · 前端 B 卷：框架原理 / 工程化 / 安全 / 手写代码 / TypeScript / 性能优化。
// 本文件是「面试刷题」工具的离线题库数据源之一，只导出纯数据、无副作用，
// 由工具页按 topic / difficulty / tags 过滤渲染，points 当自评清单用。
// 与 interviewBankFrontend.js 的分工：那份偏 JavaScript / CSS / 浏览器与网络基础，
// 这份偏框架原理与工程实践，两边 id 前缀不同（frontend- 与 frontend-b-），互不覆盖。
// 出处约定：每条题目的 sources 只写仓库 key 与仓库内相对路径前缀，不写完整 URL，
// 链接由 UI 侧拼回；repo 只能取 web-interview / FE-Interview / tech-interview-handbook /
// CS-Notes / developer-roadmap，path 必须是该仓库里真实存在的前缀，仅作学习引用。

export const FRONTEND_B_QUESTIONS = [
  {
    id: "frontend-b-framework-vue-vs-react",
    category: "frontend",
    topic: "框架原理",
    difficulty: 2,
    tags: ["Vue", "React", "响应式", "选型"],
    question: "Vue 和 React 的核心差异是什么，为什么 React 需要更多手动优化？",
    answer:
      "结论：Vue 用细粒度响应式，数据变了能精确知道哪个组件要更新；React 走不可变数据加整体重渲染，再靠调度器决定更新的优先级与时机。\n\n机制：\n- Vue 3 在渲染时通过 Proxy 收集依赖，配合编译期生成的补丁标记，运行时只做必要的比较与更新。\n- React 的 setState 只是把组件标脏，默认从该组件重新执行 render 再 diff 找差异；不可变数据让 memo 的浅比较才有意义，直接改对象而引用不变就不会更新。\n- React 把更新拆成可中断的优先级任务，Vue 的更新在微任务队列里批量刷新，粒度更细，所以大多数场景不用手动优化。\n\n实践：React 里 memo、useMemo、useCallback 的作用是打断重渲染链，滥用反而多一层比较成本；Vue 里避免把大对象整体塞进 reactive 造成深层代理开销，跨组件共享状态交给 Pinia。排查多余渲染分别看 React DevTools 的 Profiler 和 Vue DevTools 的组件渲染计数。",
    points: ["Vue 精确通知依赖它的组件", "React 靠不可变加整体重渲染", "React 多一层优先级调度"],
    follow: "同样是列表渲染，Vue 和 React 在 key 的处理上有什么区别？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "tech-interview-handbook", path: "apps/portal/" },
    ],
  },
  {
    id: "frontend-b-framework-vue3-compile-optimization",
    category: "frontend",
    topic: "框架原理",
    difficulty: 3,
    tags: ["Vue3", "编译优化", "静态提升", "Block Tree"],
    question: "Vue 3 在编译期做了哪些优化，Block Tree 解决了什么问题？",
    answer:
      "结论：Vue 3 把「哪些节点是静态的、哪些动态节点会变」提前算进编译产物，运行时只沿着动态节点走，diff 规模从整棵模板树缩到 Block 内的动态数组。\n\n机制：\n- 静态提升：纯静态节点只创建一次并复用，跳过每轮渲染的创建开销，连续的静态节点还会被合并成一段字符串。\n- 补丁标记 PatchFlags：编译期给动态节点打上 TEXT、CLASS、PROPS 等标记，运行时按标记直接改对应属性，不再逐字段比对。\n- Block Tree：v-if、v-for 会打断静态结构，Vue 用 block 收集它内部所有带标记的动态节点形成扁平数组，更新时只遍历这个数组，复杂度与动态节点数相关。\n\n实践：v-if 分支切换会重建 block，所以别把大段稳定结构放在频繁切换的分支里；手写 render 函数时动态内容不打标记就会退化成全量 diff。想看效果可以把单文件组件编译成 render 代码，检查有没有提升与标记。",
    points: ["静态节点只创建一次并复用", "补丁标记让运行时跳过比对", "Block 收集动态节点做扁平 diff"],
    follow: "静态提升之后静态节点还参与 diff 吗，它和 v-once 有什么区别？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "FE-Interview", path: "summarry/" },
    ],
  },
  {
    id: "frontend-b-framework-react-fiber-concurrent",
    category: "frontend",
    topic: "框架原理",
    difficulty: 3,
    tags: ["React", "Fiber", "并发渲染", "调度"],
    question: "React 的 Fiber 架构和并发渲染解决了什么问题？",
    answer:
      "结论：Fiber 把递归的渲染改成可中断、可恢复的链表遍历，让 React 能把长任务切片，优先响应用户输入这类高优先级更新，避免一次渲染长时间占住主线程。\n\n机制：\n- 旧的栈调和是同步递归，一旦开始就无法暂停，组件树一大就掉帧。\n- Fiber 节点用 child、sibling、return 三个指针串成链表，遍历状态自己维护，所以能随时让出主线程再接着跑。\n- 渲染分两个阶段：render 阶段可中断、可丢弃重来；commit 阶段必须一次做完，否则用户会看到半成品界面。\n- 并发特性都建在这上面：useTransition 把更新标成低优先级，useDeferredValue 先留着旧值，Suspense 在数据没准备好时先显示占位。\n\n实践：时间切片只在并发渲染开启后生效，普通 setState 仍按优先级排队；并发渲染不减少计算量，真正的重计算还是要挪进 Web Worker。排查掉帧看 Performance 面板里 render 与 commit 各自的耗时占比。",
    points: ["Fiber 用链表实现可中断遍历", "render 可中断，commit 不行", "并发特性靠优先级调度落地"],
    follow: "useTransition 和 useDeferredValue 的区别是什么，各自适合什么场景？",
    sources: [
      { repo: "tech-interview-handbook", path: "apps/portal/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-b-engineering-vite-fast",
    category: "frontend",
    topic: "工程化",
    difficulty: 2,
    tags: ["Vite", "esbuild", "ESM", "构建"],
    question: "Vite 为什么比 Webpack 快？开发和生产环境分别做了什么？",
    answer:
      "结论：开发阶段 Vite 不做打包，浏览器按原生 ESM 直接请求模块，请求到谁才编译谁，依赖只用 esbuild 预构建一次；生产环境仍然用 Rollup 打包，因为线上几百个请求反而更慢。\n\n机制：\n- 冷启动：Webpack 要先扫完整张依赖图才能起服务，项目越大越慢；Vite 启动时只拉起 dev server，编译推迟到请求时发生，启动耗时基本与项目规模无关。\n- 依赖预构建用 esbuild，它是 Go 写的，比 JS 实现快一到两个数量级；同时把 CommonJS 依赖转成 ESM，并把 lodash 这类碎模块合并成一个文件，避免请求瀑布。\n- 热更新沿模块图只让受影响的模块边界失效，HMR 耗时也不随项目增长。\n\n实践：首次访问慢是正常的，因为要现编译；依赖变了删掉 node_modules/.vite 重新预构建。monorepo 里的源码依赖要写进 optimizeDeps.include，漏了会退化成几百个请求。生产环境的 chunk 划分仍然靠 Rollup 的 manualChunks。",
    points: ["开发不打包，浏览器按需取 ESM", "esbuild 预构建并合并碎模块", "生产仍用 Rollup 打包"],
    follow: "Vite 启动很快但第一次打开页面很慢，你会怎么排查和优化？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "FE-Interview", path: "summarry/" },
    ],
  },
  {
    id: "frontend-b-engineering-bundle-splitting",
    category: "frontend",
    topic: "工程化",
    difficulty: 2,
    tags: ["拆包", "bundle", "懒加载", "缓存"],
    question: "构建产物太大，你会怎么分析体积并做拆包？",
    answer:
      "结论：先量化再拆包，用可视化报告找出占比最大的模块，再按「变更频率」和「首屏是否必需」两个维度分包，不要无脑按路由切。\n\n机制：\n- Webpack 用 webpack-bundle-analyzer，Vite 用 rollup-plugin-visualizer，看 gzip 后的体积和模块归属，业务代码与第三方依赖要分开看。\n- 分包依据是 HTTP 缓存：node_modules 里长期不变的依赖单独成 vendor chunk，配 contenthash 后能长期缓存；业务代码改动频繁，放另一个 chunk。\n- 非首屏页面用动态 import 做路由级懒加载；同一模块被多个 chunk 引用时，Rollup 会自动提取共享 chunk，Webpack 用 splitChunks 的 minChunks 控制。\n\n实践：最常见的坑是 barrel 文件把整个组件库拖进首屏，改成按具体路径引入；moment、lodash 这类大库优先换 dayjs 和 lodash-es；真正的大依赖用 CDN 外置或延迟到交互时再加载。改完要对比前后体积和 Lighthouse 指标，别为了减少请求数把首屏 chunk 撑大。",
    points: ["先用可视化报告定位大模块", "按变更频率分 vendor 与业务", "警惕 barrel 文件拖进整个库"],
    follow: "preload 和 prefetch 该用哪个，怎么避免下载了用不上的 chunk？",
    sources: [
      { repo: "FE-Interview", path: "summarry/" },
      { repo: "tech-interview-handbook", path: "apps/website/" },
    ],
  },
  {
    id: "frontend-b-engineering-pnpm-lockfile",
    category: "frontend",
    topic: "工程化",
    difficulty: 1,
    tags: ["pnpm", "npm", "lock", "依赖管理"],
    question: "npm 和 pnpm 的依赖管理差在哪？lock 文件冲突怎么处理？",
    answer:
      "结论：npm 把依赖树扁平化铺在 node_modules 里，pnpm 用全局内容寻址仓库加硬链接，node_modules 里主要是符号链接，所以更省磁盘，也能阻止访问没声明过的依赖。\n\n机制：\n- npm 的扁平化会把子依赖提升到顶层，代码里引入一个没写进 package.json 的包照样能跑，这就是幽灵依赖；多个包要求同一依赖的不同版本时，只有第一个能提升，其余嵌在各自的子目录。\n- pnpm 把真实文件放在 node_modules/.pnpm，硬链接指向全局 store，同一版本全局只存一份；每个包只能看到自己声明的依赖。\n- lock 文件记录的是整棵依赖树的解析结果，两个分支各改一次必然冲突。\n\n实践：lock 冲突不要手改，正确做法是保留一边的 package.json 后重新安装生成 lock，再跑一次 --frozen-lockfile 安装验证两者一致。CI 里用 packageManager 字段配合 corepack 固定包管理器与版本，避免 npm 与 pnpm 混用把 node_modules 结构搞乱。",
    points: ["npm 扁平提升会产生幽灵依赖", "pnpm 用硬链接与严格依赖隔离", "lock 冲突靠重装生成而非手改"],
    follow: "pnpm 的严格模式让老项目报错找不到模块，怎么平滑迁移？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "CS-Notes", path: "docs/" },
    ],
  },
  {
    id: "frontend-b-security-csp",
    category: "frontend",
    topic: "安全",
    difficulty: 3,
    tags: ["CSP", "XSS", "安全响应头"],
    question: "CSP 怎么配？它能防住什么，又防不住什么？",
    answer:
      "结论：CSP 通过响应头声明允许加载哪些来源的脚本、样式和连接，核心是禁掉内联脚本与 eval，让注入的代码执行不了；但它防不住服务端直接输出的脏数据、CSRF 与数据外带。\n\n机制：\n- 常用指令：default-src 兜底，script-src 管脚本来源，connect-src 限制 fetch 与 WebSocket 的目标，frame-ancestors 防点击劫持，report-uri 收集违规上报。\n- 关键开关是 script-src 里不加 unsafe-inline 和 unsafe-eval，这样注入的 script 标签与内联事件处理器都不会执行；确实需要内联脚本时用 nonce 或 hash 精确放行。\n- strict-dynamic 让被信任脚本再加载的脚本也获得信任，适配现代打包产物。\n\n实践：先上 Report-Only 观察一段时间再切强制模式；内联样式多时 style-src 可以先放宽，script-src 不能松。CSP 是纵深防御的一层，替代不了输入输出编码，也防不了 CSRF 和越权，服务端校验一样要做。上线前用 CSP Evaluator 检查策略里有没有形同虚设的配置。",
    points: ["用响应头声明各来源白名单", "禁内联与 eval 才挡得住 XSS", "防不住 CSRF 与数据外带"],
    follow: "配了 nonce 之后，动态插入的 script 标签为什么还是不执行？",
    sources: [
      { repo: "CS-Notes", path: "docs/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-b-security-supply-chain",
    category: "frontend",
    topic: "安全",
    difficulty: 2,
    tags: ["供应链", "postinstall", "依赖审计", "npm"],
    question: "第三方依赖的供应链风险怎么防？postinstall 脚本能做什么？",
    answer:
      "结论：安装依赖时的生命周期脚本等价于在你机器和 CI 上执行任意代码，防御靠三件事：锁死版本、默认禁用安装脚本、持续审计并控制依赖数量。\n\n机制：\n- preinstall、postinstall 这类脚本会在安装时执行，攻击者只要发布同名包或劫持维护者账号，就能在里面读环境变量、偷 token 或挖矿，event-stream、ua-parser-js 都是真实案例。\n- 锁死解析结果靠 lock 文件加 frozen-lockfile，否则 CI 按 semver 范围重新解析，可能装到刚被投毒的新版本。\n- 传递依赖同样是攻击面，一个包平均会带进来几十个间接依赖，每个都要单独信任。\n\n实践：pnpm 用 ignore-scripts 全局关掉脚本，确实需要的（esbuild、sharp 这类带原生二进制的）用 onlyBuiltDependencies 白名单放行。定期跑 audit，接 Dependabot 或 Renovate 提 PR，而不是在生产环境自动升级。关键项目把 lock 文件的 diff 纳入评审，出现来源可疑的新增包直接拦下，CI 的发布 token 也不要暴露在安装环境里。",
    points: ["postinstall 等于装包时执行代码", "lock 加 frozen 才锁得住版本", "用 ignore-scripts 加白名单放行"],
    follow: "CI 上必须允许某个包的安装脚本，怎么把权限收窄到最小？",
    sources: [
      { repo: "developer-roadmap", path: "src/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-b-handwrite-promise-all-race",
    category: "frontend",
    topic: "手写代码",
    difficulty: 2,
    tags: ["Promise", "手写", "并发", "race"],
    question: "手写 Promise.all 和 Promise.race，怎么保证结果顺序？",
    answer:
      "结论：all 的结果顺序由入参顺序决定，与完成先后无关，所以要在创建时把每个下标钉住；race 取第一个落定的结果，成功或失败都直接 settle。\n\n机制：all 内部维护剩余计数，每个子 Promise 完成后按自己的下标写入结果数组，计数归零才 resolve；任意一个 reject 就立刻 reject，但其他请求不会被取消。空数组要马上 resolve，否则计数永远不归零。\n\n实践：\n```js\nconst all = (list) => new Promise((ok, no) => {\n  const a = Array.from(list);\n  const r = new Array(a.length);\n  let n = a.length;\n  if (!n) return ok(r);\n  a.forEach((p, i) => Promise.resolve(p).then(\n    (v) => { r[i] = v; if (!--n) ok(r); },\n    no\n  ));\n});\n```\n需要允许部分失败就用 allSettled 收集 status 与 reason，它不会因为一个失败就丢掉其他结果；手写 race 同样要用 Promise.resolve 包一层，才能兼容传进来的非 Promise 值。另外 Promise 只能 settle 一次，第一个 reject 之后的失败都会被忽略，也不会取消还在跑的请求。",
    points: ["结果按入参下标写入，与快慢无关", "计数归零才 resolve，空数组特判", "race 不取消其他任务，要配 abort"],
    follow: "如果要求并发数不超过 3，这个 all 要怎么改？",
    sources: [
      { repo: "FE-Interview", path: "demos/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-b-handwrite-call-apply-bind",
    category: "frontend",
    topic: "手写代码",
    difficulty: 1,
    tags: ["call", "apply", "bind", "this"],
    question: "手写 call、apply、bind，关键点分别是什么？",
    answer:
      "结论：三者都是改 this 指向：call 逐个传参并立即执行，apply 用数组传参并立即执行，bind 返回一个绑好 this 和预设参数的新函数，可以稍后再调用。\n\n机制：实现思路都是把函数临时挂到目标对象上调用，借「方法调用时 this 指向调用者」拿到想要的 this，调用完删掉临时属性避免污染对象。细节是 this 传 null 或 undefined 时按非严格模式落到全局对象，传原始值会被包装成对象；临时属性用 Symbol 做键避免重名。\n\n实践：\n```js\nFunction.prototype.myCall = function (ctx, ...args) {\n  ctx = ctx == null ? globalThis : Object(ctx);\n  const k = Symbol();\n  ctx[k] = this;\n  const out = ctx[k](...args);\n  delete ctx[k];\n  return out;\n};\n```\nbind 还要兼容 new：用 new 调用时 this 应指向新实例而不是绑定的对象，可以判断 this instanceof 包装函数，或者直接用 Reflect.construct。箭头函数没有自己的 this，bind 对它无效。",
    points: ["临时挂到目标对象上借用 this", "用完删属性，键用 Symbol", "bind 要兼容 new 与箭头函数"],
    follow: "为什么 bind 之后再用 call 改 this 改不动？",
    sources: [
      { repo: "FE-Interview", path: "demos/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-b-handwrite-event-bus",
    category: "frontend",
    topic: "手写代码",
    difficulty: 1,
    tags: ["事件总线", "发布订阅", "手写", "内存泄漏"],
    question: "手写一个事件总线，on、off、emit、once 各要注意什么？",
    answer:
      "结论：核心是一张「事件名到回调数组」的映射；emit 前要先拷贝数组再遍历，once 在触发后自动解绑，off 不传回调时清空该事件的全部监听。\n\n机制：直接遍历原数组时，回调里调用 off 会改变数组长度，导致后面的监听器被跳过，所以 emit 要先用 slice 复制一份。once 的正确实现是把原回调挂在包装函数的属性上，off 时按原回调匹配删除，否则用户拿着原函数解绑不掉。\n\n实践：\n- 单个监听器抛错不该影响其他监听器，emit 里要逐个 try/catch 并上报。\n- 组件卸载必须解绑，否则回调闭包持有组件实例会造成内存泄漏，Vue 2 的 $on 与 $off 就是这个模型。\n- 需要按调用方批量清理时，可以用 WeakMap 以调用方为键分组存监听。\n- 同步 emit 更好排查，异步 emit 能避免回调里再触发导致调用栈过深。",
    points: ["映射存事件名与回调数组", "emit 前拷贝，避免边遍历边删", "once 包装后要能按原回调解绑"],
    follow: "如果用 Proxy 实现响应式，依赖收集和触发更新怎么组织？",
    sources: [
      { repo: "FE-Interview", path: "summarry/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-b-typescript-generics-infer",
    category: "frontend",
    topic: "TypeScript",
    difficulty: 3,
    tags: ["TypeScript", "泛型", "条件类型", "infer"],
    question: "泛型约束和条件类型怎么配合？infer 能推断出什么？",
    answer:
      "结论：泛型约束用 extends 限定入参范围，条件类型按「A 能否赋给 B」分支，infer 则在 extends 的模式里声明一个待推断的类型变量，把匹配到的部分提取出来。\n\n机制：\n- 约束只是收窄可用的类型范围，不影响运行时；keyof 与索引访问配合约束，能表达「属性名必须是对象已有的键」这类签名。\n- 条件类型作用在裸类型参数上会分发：传联合类型时逐个成员判断再合并结果，这既是特性也是坑，用一层额外包裹可以关掉分发。\n- infer 常见用法是从函数类型提取返回值、从 Promise 提取解析后的类型、从数组提取元素类型，同一模式里出现多个 infer 还能在协变位置做推断。\n\n实践：\n```ts\ntype ElementOf<T> = T extends (infer U)[] ? U : never;\ntype Unwrap<T> = T extends Promise<infer U> ? Unwrap<U> : T;\n```\n判断联合类型是否为空要用方括号包一层，否则 never 的分发会让结果恒为 never；递归类型必须有终止分支，不然会报类型实例化过深。业务代码里别为了炫技堆深层条件类型，报错信息会变得没法读，能用泛型约束或函数重载表达就别上 infer。",
    points: ["extends 用来约束入参范围", "裸类型参数上的条件类型会分发", "infer 提取返回值与元素类型"],
    follow: "为什么 A extends B ? never : T 在联合类型上结果不对？",
    sources: [
      { repo: "tech-interview-handbook", path: "apps/portal/" },
      { repo: "developer-roadmap", path: "src/" },
    ],
  },
  {
    id: "frontend-b-typescript-unknown-never-guards",
    category: "frontend",
    topic: "TypeScript",
    difficulty: 2,
    tags: ["TypeScript", "unknown", "never", "类型守卫"],
    question: "unknown、any、never 分别什么时候用？类型守卫怎么写？",
    answer:
      "结论：any 放弃检查，unknown 是必须先用类型守卫收窄才能使用的安全版 any，never 表示不可能出现的值，常用于穷尽检查；类型守卫是把 unknown 或联合类型收窄到具体类型的唯一手段。\n\n机制：\n- 外部输入（接口响应、JSON.parse 的结果、catch 到的错误、第三方回调）都先声明成 unknown，再用 typeof、instanceof、in 或自定义守卫逐层收窄，漏判会在编译期报错而不是线上崩。\n- never 是所有类型的子类型，返回值标 never 表示必定抛错或死循环；在 switch 的 default 分支里把参数赋给一个 never 变量，新增分支时就会编译失败。\n- 守卫有两种：返回「参数 is 类型」的函数能在表达式里用，断言函数 asserts 适合校验后直接往下走。\n\n实践：别用 as 冒充守卫，那只是骗过编译器；判断数组要 Array.isArray 加元素类型检查，判断对象要排除 null 且 typeof 为 object。catch 到的错误在 TS 4.4 之后是 unknown，先 instanceof Error 再读 message，否则拿不到有用的堆栈。",
    points: ["外部输入先声明 unknown 再收窄", "never 用于穷尽检查与必抛错", "守卫用 is 或 asserts 而不是 as"],
    follow: "在 switch 里做穷尽检查，漏掉一个分支怎么让它编译不过？",
    sources: [
      { repo: "CS-Notes", path: "docs/" },
      { repo: "developer-roadmap", path: "src/" },
    ],
  },
  {
    id: "frontend-b-perf-virtual-list",
    category: "frontend",
    topic: "性能优化",
    difficulty: 2,
    tags: ["虚拟列表", "长列表", "性能", "不定高"],
    question: "长列表有几万条数据，虚拟列表是怎么实现的？",
    answer:
      "结论：只渲染可视区域加上下缓冲区内的几十个节点，用一个撑高的占位元素保留真实滚动条长度，滚动时按 scrollTop 换算出该渲染的区间。\n\n机制：\n- 定高最简单：每项高度 h、可视高度 H，起始下标就是 scrollTop 除以 h 取整，渲染数量是 H 除以 h 向上取整再加缓冲区，用 padding-top 或 transform 把内容顶到正确位置。\n- 不定高有两种做法：一是先按预估高度渲染，测量真实高度写回缓存，用前缀和加二分查找定位起始下标；二是用 ResizeObserver 持续修正，滚动中高度变化会导致跳动，需要按锚点元素校正偏移。\n- 滚动事件要收敛到 requestAnimationFrame 里处理，避免每个 scroll 事件都触发一次渲染。\n\n实践：常见坑是缓冲区太小导致快速滚动白屏，一般上下各留 3 到 5 项；列表项里有图片时要用固定尺寸占位，否则测到的高度会反复变化。数据量特别大时直接用 react-window 或 vue-virtual-scroller，自己写要重点测不定高与滚动锚定。",
    points: ["只渲染可视区加缓冲区节点", "占位元素撑出真实滚动条", "不定高靠测量缓存加前缀和"],
    follow: "不定高列表滚动时内容跳动，锚点校正是怎么做的？",
    sources: [
      { repo: "FE-Interview", path: "demos/" },
      { repo: "tech-interview-handbook", path: "apps/website/" },
    ],
  },
];
