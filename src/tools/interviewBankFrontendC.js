// 面试题库 · 前端 · JS 进阶 / CSS 布局 / 浏览器与网络 / 场景与协作 / 可访问性与体验。
// 本文件是「面试刷题」工具的纯数据模块，导出 FRONTEND_C_QUESTIONS，与 interviewBankFrontend.js
// 同为前端方向的分片，区别是本片只收机制类与场景类题目：JS 进阶、CSS 布局、浏览器与网络、
// 场景与协作、可访问性与体验五个主题，不重复基础 API 背诵题。
// 来源归属约定：每条 sources 只写仓库 key 与仓库内相对路径前缀，不写完整 URL，
// 由 UI 侧（sourceLinks）拼回链，可选仓库为 web-interview / FE-Interview /
// tech-interview-handbook / CS-Notes / developer-roadmap。

export const FRONTEND_C_QUESTIONS = [
  {
    id: "frontend-c-js-esm-commonjs",
    category: "frontend",
    topic: "JavaScript 进阶",
    difficulty: 2,
    tags: ["ESM", "CommonJS", "循环依赖"],
    question: "ESM 和 CommonJS 的本质差异在哪？为什么打包器更偏爱 ESM？",
    answer:
      "结论：CommonJS 是运行时加载、导出值拷贝；ESM 是编译期静态分析、导出实时绑定，这是两者所有差异的根源。\n\n机制：\n- ESM 的 import 与 export 必须在顶层，打包器构建期就能确定依赖图，因此能做 tree-shaking 与循环依赖预分析；require 是普通函数调用，路径可以是变量，只能运行时解析。\n- CommonJS 导出的是值的快照，模块内部后续改变量不会同步给引用方；ESM 导出的是实时绑定，读取时总能拿到最新值。\n- 循环依赖时 ESM 先建好模块记录再执行，访问未初始化的绑定会抛 ReferenceError；CommonJS 则可能拿到半成品的不完整导出对象。\n\n实践：新项目一律 ESM；引第三方 CommonJS 包时用默认导入拿 module.exports。排查循环依赖用 madge 或打包器的循环警告，优先把共享部分抽成第三个模块。",
    points: ["运行时加载与编译期静态分析", "值拷贝对比实时绑定", "循环依赖时表现不同"],
    follow: "同一个包同时提供两种入口时，打包器是怎么选 main 还是 module 的？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "FE-Interview", path: "summarry/" },
    ],
  },
  {
    id: "frontend-c-js-this-binding",
    category: "frontend",
    topic: "JavaScript 进阶",
    difficulty: 2,
    tags: ["this", "箭头函数", "call"],
    question: "this 的绑定规则有哪几条？箭头函数为什么不受这些规则影响？",
    answer:
      "结论：this 在调用时确定，优先级从高到低是 new 绑定、显式绑定（call、apply、bind）、隐式绑定（对象方法调用）、默认绑定（严格模式为 undefined，非严格为全局对象）。\n\n机制：\n- 箭头函数没有自己的 this，它在定义时就捕获外层作用域的 this，所以传什么都改不了，也不能当构造函数用，它没有 prototype。\n- 隐式绑定会丢失：把对象方法赋给变量再调用，调用位置左边没有对象，就退化成默认绑定，这是回调里 this 变成 undefined 的常见原因。\n- bind 只绑定一次，之后再 bind 无效，返回的新函数同样没有 prototype。\n\n实践：需要动态 this 用普通函数，需要固定外层 this 用箭头函数；对象方法不要写成箭头函数，否则拿不到实例。排查时只看调用点左边是谁，别盯着定义处。",
    points: ["this 由调用位置决定", "箭头函数捕获外层 this", "隐式绑定容易丢失"],
    follow: "严格模式下把方法解构出来调用，this 是什么？",
    sources: [
      { repo: "FE-Interview", path: "summarry/" },
      { repo: "CS-Notes", path: "docs/" },
    ],
  },
  {
    id: "frontend-c-js-equality-coercion",
    category: "frontend",
    topic: "JavaScript 进阶",
    difficulty: 1,
    tags: ["===", "类型转换", "NaN"],
    question: "== 和 === 的区别是什么，什么时候必须用 ===？",
    answer:
      "结论：=== 不做类型转换，类型不同直接为 false；== 会先按抽象相等比较的规则转成同一类型，规则多且反直觉，团队规范一般禁用 ==，只保留 x == null 这一种写法。\n\n机制：\n- == 的转换顺序：同类型直接比；null 与 undefined 互等，且不等于其他任何值；数字与字符串比较时把字符串转数字；遇到布尔值先转数字；对象与原始值比较时调 ToPrimitive，先 valueOf 再 toString。\n- 经典坑：数字 0 与空字符串用 == 相等，空数组与 false 用 == 相等，NaN 与任何值都不相等，包括它自己。\n\n实践：判 NaN 用 Number.isNaN，判负零用 Object.is；对象比较始终是引用比较，要比内容得自己写或上 lodash.isEqual；表单拿到的都是字符串，与数字比较前显式转换，别指望 == 兜底。",
    points: ["=== 不做隐式类型转换", "== 走 ToPrimitive 转换链", "NaN 用 isNaN 判断"],
    follow: "Object.is 和 === 在哪些值上结果不一样？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "developer-roadmap", path: "src/" },
    ],
  },
  {
    id: "frontend-c-js-gc-weakmap",
    category: "frontend",
    topic: "JavaScript 进阶",
    difficulty: 3,
    tags: ["GC", "WeakMap", "WeakRef"],
    question: "V8 怎么判断对象可以回收？WeakMap 和 WeakRef 各解决什么问题？",
    answer:
      "结论：V8 用可达性分析，从 GC Roots（全局对象、调用栈、闭包上下文）出发标记可达对象，不可达的才回收；WeakMap 的键与 WeakRef 的目标都是弱引用，不阻止回收。\n\n机制：\n- 分代回收：新生代用 Scavenge 复制算法，经历两轮还活着的对象晋升老生代；老生代用标记清除加标记整理，并发标记靠三色标记处理边标记边改引用。\n- WeakMap 的键是弱引用，键对象被回收后整个键值对自动消失，而且不可遍历；WeakSet 同理。WeakRef 的 deref 可能返回 undefined，可配 FinalizationRegistry 做回收回调。\n\n实践：给 DOM 节点挂缓存元数据、存对象关联的私有数据，用 WeakMap 而非 Map，避免节点移除后仍被缓存持有。WeakRef 只适合可重建的缓存，回收时机不确定，不能用来保证逻辑正确。",
    points: ["可达性分析决定回收", "WeakMap 键是弱引用", "WeakRef 时机不确定"],
    follow: "Map 里存 DOM 节点为什么会导致内存泄漏，怎么验证？",
    sources: [
      { repo: "CS-Notes", path: "docs/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-c-css-centering",
    category: "frontend",
    topic: "CSS 布局",
    difficulty: 1,
    tags: ["居中", "flex", "绝对定位"],
    question: "水平垂直居中你一般怎么写？不同方案分别适合什么场景？",
    answer:
      "结论：现代项目首选 flex 或 grid 居中，不必知道子元素尺寸；需要脱离文档流叠加时才用绝对定位加 transform。\n\n机制：\n- flex 容器设 display: flex、justify-content: center、align-items: center 即可两轴居中；单子元素时 grid 的 place-items 也能一行搞定。\n- 绝对定位方案：父元素 relative，子元素 absolute 加 inset: 0 与 margin: auto，靠自动外边距吃掉剩余空间。\n- 单行文本可用 text-align 加 line-height 等于高度，多行会溢出。\n\n实践：弹窗遮罩用 flex；宽高未知又要做位移动画时用 translate(-50%, -50%)，但它会创建包含块，可能让内部 fixed 失效。排查先确认父元素有确定高度，否则垂直居中无从谈起。",
    points: ["flex 与 grid 一行居中", "绝对定位加 auto 外边距", "transform 会创建包含块"],
    follow: "父元素高度是 auto 时，垂直居中还能生效吗？",
    sources: [
      { repo: "FE-Interview", path: "summarry/" },
      { repo: "developer-roadmap", path: "src/" },
    ],
  },
  {
    id: "frontend-c-css-mobile-1px",
    category: "frontend",
    topic: "CSS 布局",
    difficulty: 2,
    tags: ["1px 边框", "rem", "vw 适配"],
    question: "移动端 1px 边框为什么变粗？rem 和 vw 适配怎么选？",
    answer:
      "结论：CSS 像素是逻辑像素，设备像素比为 2 或 3 时，1px 会渲染成 2 到 3 个物理像素，于是边框变粗；适配要在 rem 与 vw 之间选一个。\n\n机制：\n- 细边框三种解法：伪元素配 transform: scaleY(0.5) 画线，用 transform-origin 控制方向；直接写 0.5px，低版本安卓会忽略小数；用 box-shadow 的 0 0 0 0.5px 描边。\n- rem 由 JS 按屏宽设根字号，配 postcss 插件换算，能整体缩放但多一层 JS 依赖；vw 由 CSS 自己算，1vw 是视口宽度的百分之一。\n- 动态 viewport 指用 vw 配 clamp 限制字号上下限，避免大屏字过大。\n\n实践：优先 vw 加 clamp，设计稿宽 750px 时 1px 约 0.1333vw；真机上用设备模拟改 dpr 复核。",
    points: ["dpr 让 1px 渲染成多像素", "伪元素 scaleY 是稳妥解法", "vw 配 clamp 限制上下限"],
    follow: "1px 方案在圆角元素上会出现什么瑕疵，怎么处理？",
    sources: [
      { repo: "FE-Interview", path: "demos/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-c-css-stacking-context",
    category: "frontend",
    topic: "CSS 布局",
    difficulty: 3,
    tags: ["层叠上下文", "z-index", "定位"],
    question: "z-index 设得很大还是不生效，通常是什么原因？",
    answer:
      "结论：z-index 只在同一个层叠上下文内比较，跨上下文时数值再大也没用；而且它只对定位元素或 flex、grid 子项生效。\n\n机制：\n- 创建层叠上下文的常见属性：根元素；absolute 或 relative 且 z-index 不为 auto；fixed 或 sticky；opacity 小于 1；transform、filter。\n- 父元素成为层叠上下文后，子元素的 z-index 就被关在里面，与外部兄弟隔离，这是弹窗被遮挡的根因。\n- 层叠顺序自下而上：背景边框、负 z-index、块级盒子、浮动盒子、行内内容、z-index 为 0 或 auto、正 z-index。\n\n实践：排查在 DevTools 的 Layers 面板看谁创建了上下文；解法是把弹窗 teleport 到 body，或去掉祖先多余的 transform 与 opacity。",
    points: ["跨上下文比 z-index 无效", "transform 等会创建上下文", "弹窗挂到 body 规避隔离"],
    follow: "父元素加了 opacity 动画后弹窗被挡住，怎么改最小？",
    sources: [
      { repo: "FE-Interview", path: "summarry/" },
      { repo: "developer-roadmap", path: "src/" },
    ],
  },
  {
    id: "frontend-c-browser-storage-choice",
    category: "frontend",
    topic: "浏览器与网络",
    difficulty: 1,
    tags: ["Cookie", "localStorage", "IndexedDB"],
    question: "Cookie、localStorage、sessionStorage、IndexedDB 该怎么选？",
    answer:
      "结论：按容量、生命周期、是否随请求发送来选：凭证放 Cookie，配置放 localStorage，会话数据放 sessionStorage，大块结构化数据放 IndexedDB。\n\n机制：\n- Cookie 约 4KB，每次同源请求都自动带上，所以只放会话标识；加 HttpOnly 后 JS 读不到，能防 XSS 窃取。\n- localStorage 约 5MB，永久保存、同源共享，同步 API 会阻塞主线程；sessionStorage 同样约 5MB，关掉标签页就清空，也不跨标签页共享。\n- IndexedDB 按磁盘配额，可存几百 MB，异步且支持索引与事务，适合离线数据与大缓存。\n\n实践：登录态优先 HttpOnly Cookie；localStorage 只放非敏感偏好；写大对象要防抖，避免同步写卡住渲染；IndexedDB 用 idb 封装降复杂度。",
    points: ["Cookie 随请求自动携带", "localStorage 同步会阻塞", "IndexedDB 异步且容量大"],
    follow: "为什么说不该把登录 token 放在 localStorage 里？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "tech-interview-handbook", path: "apps/website/" },
    ],
  },
  {
    id: "frontend-c-browser-service-worker",
    category: "frontend",
    topic: "浏览器与网络",
    difficulty: 3,
    tags: ["Service Worker", "离线缓存", "PWA"],
    question: "Service Worker 的离线缓存怎么做？更新时怎么避免用户拿到旧页面？",
    answer:
      "结论：Service Worker 是独立于页面的后台线程，能拦截同源请求，离线能力靠它在 fetch 事件里决定走缓存还是网络；难点不在缓存，而在版本更新。\n\n机制：\n- 生命周期是 install、activate、fetch：install 用 cache.addAll 预缓存关键资源，activate 清掉旧版本缓存，fetch 按策略返回。\n- 常用策略：HTML 走网络优先并回退缓存，带哈希的静态资源走缓存优先，接口数据走 stale-while-revalidate。\n- 新版本装好后进入 waiting 状态，要等旧页面全关才激活，用户可能长时间停在旧版本。\n\n实践：在 updatefound 里监听并提示刷新，或调 skipWaiting 配 clients.claim 立即接管，但要接受新旧资源混用的风险。缓存名带构建号，避免脏缓存。",
    points: ["install 预缓存 activate 清旧", "按资源类型分缓存策略", "waiting 状态导致更新滞后"],
    follow: "skipWaiting 之后页面里已加载的旧 JS 会怎样，有什么风险？",
    sources: [
      { repo: "tech-interview-handbook", path: "apps/portal/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-c-network-cors-practice",
    category: "frontend",
    topic: "浏览器与网络",
    difficulty: 2,
    tags: ["跨域", "CORS", "代理"],
    question: "前端跨域你实际怎么解决？代理、CORS、JSONP 的边界在哪？",
    answer:
      "结论：跨域是同源策略对浏览器的限制，请求其实发出去了、只是响应被拦；生产环境的正解是后端配 CORS 或同域反向代理，JSONP 只作老旧系统的兜底。\n\n机制：\n- CORS 由服务端响应头决定：简单请求直接发，带自定义头或非简单方法会先发 OPTIONS 预检；响应要带 Access-Control-Allow-Origin，携带 Cookie 时不能写星号，还要开 Allow-Credentials。\n- 开发环境用构建工具的 proxy 转发到后端，浏览器看到的是同源，联调最省事。\n- JSONP 靠 script 标签绕过限制，只能发 GET、拿不到状态码、无法判断失败，还有注入风险，现代项目不该再用。\n\n实践：优先同域反向代理，其次标准 CORS；预检失败先看响应头，别急着改前端代码；自定义头能减就减，少一次预检往返。iframe 通信走 postMessage。",
    points: ["跨域是响应被拦不是没发", "预检由自定义头触发", "JSONP 只支持 GET 且有风险"],
    follow: "带 Cookie 的跨域请求，前端 fetch 要额外设什么？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "FE-Interview", path: "summarry/" },
    ],
  },
  {
    id: "frontend-c-network-dns-tcp-tls",
    category: "frontend",
    topic: "浏览器与网络",
    difficulty: 2,
    tags: ["DNS", "TLS", "性能优化"],
    question: "一次 HTTPS 请求里 DNS、TCP、TLS 各占多少时间？怎么优化？",
    answer:
      "结论：首次请求里 DNS 通常几毫秒到几十毫秒，TCP 握手一个 RTT，TLS 握手在 1.3 下是 1 个 RTT（1.2 要 2 个）；真正的大头往往是服务端处理与资源体积。\n\n机制：\n- DNS 依次查浏览器缓存、系统缓存、hosts、递归解析器，未命中时耗时最不可控。\n- TCP 三次握手消耗一个 RTT，之后才开始加密协商；TLS 1.3 把密钥协商合并进一个 RTT，会话恢复还能做到 0-RTT。\n- 建连成本只在首次支付，之后靠连接复用摊薄，所以 HTTP/2 多路复用能减少握手次数。\n\n实践：用 dns-prefetch 提前解析、preconnect 提前建连；服务端开 TLS 1.3 与会话复用，配 OCSP Stapling 省一次证书校验；静态资源上 CDN 就近接入。排查看 Network 面板 Timing 的 DNS 与 SSL 分项。",
    points: ["DNS 耗时最不可控", "TLS 1.3 只需一个 RTT", "preconnect 提前建连"],
    follow: "preconnect 和 dns-prefetch 该给哪些域名加，加多了有什么代价？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "developer-roadmap", path: "src/" },
    ],
  },
  {
    id: "frontend-c-scene-white-screen",
    category: "frontend",
    topic: "场景与协作",
    difficulty: 3,
    tags: ["白屏", "线上排查", "监控"],
    question: "线上突然白屏，你的排查顺序是什么？",
    answer:
      "结论：先判断范围再定位层次——全体还是部分用户、是否新版本引入，再按 CDN、产物、运行时错误、监控四层收敛。\n\n排查顺序：\n- 资源层：Network 面板确认 HTML 与主 JS 是否 404 或 502，CDN 回源失败、证书过期都会让入口脚本拿不到。\n- 产物层：对比发布记录，检查 index.html 引用的哈希文件名与实际文件是否一致，灰度与回滚时最常见新旧错配。\n- 运行时层：看 Console 报错与 window.onerror、unhandledrejection 上报，用 Source Map 还原堆栈，多因接口结构变化导致渲染抛错。\n- 监控层：把错误率、白屏率曲线与发布时刻对齐，确认影响面。\n\n实践：先止血再定位，能回滚就回滚；入口脚本加 onerror 兜底，关键渲染加错误边界；事后补一条白屏检测（看根节点高度或关键 DOM 是否存在）做告警。",
    points: ["先定范围再分层定位", "资源与产物错配最常见", "先回滚止血再查根因"],
    follow: "如果只有部分机型白屏，你会怎么缩小范围？",
    sources: [
      { repo: "tech-interview-handbook", path: "apps/portal/" },
      { repo: "FE-Interview", path: "summarry/" },
    ],
  },
  {
    id: "frontend-c-scene-api-contract",
    category: "frontend",
    topic: "场景与协作",
    difficulty: 2,
    tags: ["接口契约", "错误码", "分页"],
    question: "和后端联调时，接口契约你会怎么定？",
    answer:
      "结论：契约要在写代码前用文档或 OpenAPI 定死，重点是统一响应结构、错误码、分页、时间格式和字段可空性，否则联调时间全花在猜字段上。\n\n约定要点：\n- 统一响应体：code、message、data 三段。HTTP 状态码表达传输层语义，业务码表达业务语义，两者不要混用；分页信息放 data 里，含 total、page、size、list。\n- 错误码按模块分段管理，前端只对少数要特殊处理的码做分支，其余统一提示，避免前端写一长串条件判断。\n- 时间统一用 ISO 8601 带时区的字符串或时间戳，不要传格式化好的中文；字段可空性要显式声明，列表一律给空数组而不是 null。\n\n实践：先用 TypeScript 类型或 Mock 对齐，接口变更走新增字段或版本而不是改语义；联调前先跑通一个接口的完整链路；契约写进文档并在评审时过一遍，比事后对字段便宜得多。",
    points: ["响应体与业务码统一", "错误码分段减少分支", "时间与可空性显式声明"],
    follow: "后端说字段一定不为空，前端还要不要做防御？",
    sources: [
      { repo: "tech-interview-handbook", path: "apps/website/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-c-a11y-engineering",
    category: "frontend",
    topic: "可访问性与体验",
    difficulty: 1,
    tags: ["无障碍", "语义化", "键盘可达"],
    question: "无障碍为什么是工程要求，而不是加分项？",
    answer:
      "结论：无障碍首先是可用性与合规要求，其次才是道德加分——键盘用户、读屏用户、临时受伤的人用的是同一套界面，做不好就是功能不可用。\n\n机制：\n- 语义化标签自带角色与状态：button 天然可聚焦、回车空格可触发，换成 div 加 onclick 就得手动补 tabindex、role 和键盘事件，成本更高还容易漏。\n- 读屏软件读的是可访问性树，label 与输入框的关联、图片的 alt、aria-live 的播报、焦点管理决定信息能否被读出来；aria 只是补充，语义化标签优先。\n- 法规层面，政务与海外产品常有无障碍达标要求，验收不过会直接阻塞上线。\n\n实践：优先用原生控件再补 aria；保证 Tab 顺序合理、焦点可见、弹窗打开后焦点被困住且关闭后归位；正文对比度至少 4.5:1，别只靠颜色传达状态。用 axe 或 Lighthouse 做自动检查，再手动过一遍键盘。",
    points: ["语义化标签自带角色状态", "读屏依赖可访问性树", "对比度至少 4.5 比 1"],
    follow: "自定义下拉组件要补哪些 aria 属性和键盘交互？",
    sources: [
      { repo: "developer-roadmap", path: "src/" },
      { repo: "tech-interview-handbook", path: "apps/portal/" },
    ],
  },
];
