// 面试题库 · 前端 / 浏览器。
// 本文件是「面试刷题」工具的纯数据模块，导出 FRONTEND_QUESTIONS 供题库页读取，
// 按 topic 分组、按 difficulty 筛选，并用 points 做自评打分清单。
// 内容覆盖 JavaScript、CSS、浏览器、网络与缓存、性能优化、框架原理、工程化、
// 安全、手写代码九个方向，偏重机制理解而非 API 背诵。
// 来源归属约定：每条 sources 只写仓库 key 与仓库内相对路径前缀，不写完整 URL，
// 由 UI 侧拼回链，可选仓库为 web-interview / FE-Interview /
// tech-interview-handbook / CS-Notes / developer-roadmap。

export const FRONTEND_QUESTIONS = [
  {
    id: "frontend-js-event-loop",
    category: "frontend",
    topic: "JavaScript",
    difficulty: 2,
    tags: ["事件循环", "宏任务", "微任务"],
    question: "说说浏览器的事件循环，宏任务和微任务分别什么时候执行？",
    answer:
      "结论：JS 是单线程，事件循环负责在调用栈清空后从任务队列取任务执行；每执行完一个宏任务，就把微任务队列一次性清空，然后才轮到渲染。\n\n机制：\n- 宏任务包括 setTimeout、setInterval、MessageChannel、I/O；微任务包括 Promise.then、queueMicrotask、MutationObserver。\n- 一轮循环的顺序是：取一个宏任务执行 → 清空全部微任务 → 需要时执行 requestAnimationFrame 回调 → 样式计算、布局、绘制 → 进入下一轮。\n- 微任务里再产生微任务会在本轮全部执行完，所以递归产生微任务会把渲染饿死，页面直接卡住。\n\n实践：动画用 rAF 而不是定时器，因为 rAF 对齐刷新率；setTimeout 嵌套超过 5 层后最小延迟被钳到 4ms，做不了精确调度。排查卡顿用 Performance 面板看长任务里是谁在占用主线程。",
    points: ["JS 单线程，栈空后才取任务", "每个宏任务后清空全部微任务", "微任务递归会阻塞渲染"],
    follow: "setTimeout 和 Promise.then 同时注册，输出顺序是什么，为什么？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "FE-Interview", path: "summarry/" },
    ],
  },
  {
    id: "frontend-js-closure",
    category: "frontend",
    topic: "JavaScript",
    difficulty: 1,
    tags: ["闭包", "作用域", "内存"],
    question: "什么是闭包？它为什么能读到外层变量，又为什么会造成内存问题？",
    answer:
      "结论：闭包是函数和它定义时词法作用域的组合，只要函数还被引用，它引用的外层变量就不会被回收。\n\n机制：JS 用词法作用域，函数在创建时就确定了变量查找链。V8 会把被内层函数引用的变量从栈上搬到堆里的 Context 对象，函数对象持有这个 Context 的引用，于是外层函数执行完，变量依然活着。\n\n实践：\n- 常见用途是计数器、防抖节流里保存 timer、模块模式做私有变量。\n- 内存问题往往不是闭包本身，而是闭包长期持有大对象或 DOM 引用，典型是事件监听没解绑、定时器没清除、全局缓存只写不删。\n- 排查用 Memory 面板取操作前后两次堆快照做 Comparison，重点看 Detached DOM 和 retained size。",
    points: ["函数加词法作用域的组合", "被引用变量提升到堆上保留", "泄漏多因未解绑或未清定时器"],
    follow: "循环里用 var 注册事件为什么都打印最后一个值，怎么改？",
    sources: [
      { repo: "FE-Interview", path: "summarry/" },
      { repo: "CS-Notes", path: "docs/" },
    ],
  },
  {
    id: "frontend-js-prototype-chain",
    category: "frontend",
    topic: "JavaScript",
    difficulty: 1,
    tags: ["原型链", "prototype", "继承"],
    question: "讲讲原型链，访问一个属性时的查找顺序是怎样的？",
    answer:
      "结论：每个对象都有隐式原型指向另一个对象，读属性时先查自身，再沿原型逐级向上，直到原型为 null 才返回 undefined。\n\n机制：函数有 prototype 属性指向它的原型对象，原型对象的 constructor 又指回函数；实例的隐式原型用 Object.getPrototypeOf 读取，正好等于构造函数的 prototype。所以方法挂在原型上能被所有实例共享，不必每个实例复制一份。class 只是原型继承的语法糖，extends 把子类原型链接到父类原型上，super 就沿这条链查找。\n\n实践：\n- 判断类型优先用 Array.isArray 或 Object.prototype.toString.call，instanceof 依赖原型链，跨 iframe 传递的对象会判断失败。\n- 改原型会影响所有实例，生产环境不要给内置原型打补丁。\n- 用 Object.create(null) 可以得到没有原型的纯字典对象，避免原型上的键名干扰遍历。",
    points: ["先查自身再沿原型向上", "prototype 与隐式原型的关系", "instanceof 依赖原型链有坑"],
    follow: "new 一个对象的过程中，构造函数里的 this 是怎么绑定的？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "CS-Notes", path: "docs/" },
    ],
  },
  {
    id: "frontend-js-async-promise",
    category: "frontend",
    topic: "JavaScript",
    difficulty: 3,
    tags: ["Promise", "async", "并发控制"],
    question: "async/await 和 Promise 是什么关系？并发请求怎么写才不会串行？",
    answer:
      "结论：async 函数本质是返回 Promise 的语法糖，await 只是把后续代码注册成 then 回调，它不开新线程，也不会让请求自动并行。\n\n机制：执行到 await 时函数挂起并让出调用栈，Promise 落定后把后续逻辑作为微任务恢复。所以 for 循环里逐个 await 会让请求串行，总耗时等于各次耗时之和，而不是最大值。\n\n实践：\n- 要并行就先把 Promise 建好再等：const list = urls.map(u => fetch(u)); const res = await Promise.all(list);\n- 允许部分失败用 Promise.allSettled，只要最快的结果用 Promise.race，但 race 不会取消输掉的请求，得配 AbortController。\n- 并发数要自己控：维护固定大小的执行池，完成一个补一个，否则会瞬时占满浏览器同域约 6 个连接的限制。\n- await 必须用 try/catch 包住，否则失败会变成 unhandledrejection。",
    points: ["async 返回 Promise，await 是 then", "循环里串行 await 会累加耗时", "并发用 all 加执行池限流"],
    follow: "Promise.all 里有一个 reject，其他请求还会继续吗，结果怎么处理？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "tech-interview-handbook", path: "apps/portal/" },
    ],
  },
  {
    id: "frontend-css-box-model",
    category: "frontend",
    topic: "CSS",
    difficulty: 1,
    tags: ["盒模型", "box-sizing", "margin 塌陷"],
    question: "标准盒模型和 IE 盒模型的区别是什么，项目里一般怎么选？",
    answer:
      "结论：区别在 width 的含义。标准盒模型里 width 只算内容区，IE 盒模型即 border-box 的 width 包含 padding 和 border。\n\n机制：box-sizing 默认是 content-box，写 width 100px 再加 padding 10px，实际占位变成 120px；border-box 下内容区被自动压缩，占位恒为 100px。margin 两种模型都不计入，而且垂直方向相邻元素的 margin 会塌陷，取两者较大值。\n\n实践：\n- 全局统一设成 border-box，布局时宽度可预期，不用反复做减法。\n- offsetWidth 包含 border 和滚动条，getBoundingClientRect 返回的是变换后的视觉尺寸，做动画测量要分清用哪个。\n- 百分比 padding 按包含块宽度计算，常用来做固定宽高比占位，避免加载时跳动。",
    points: ["width 是否含 padding 与 border", "border-box 让占位可预期", "margin 不计入且垂直会塌陷"],
    follow: "百分比 padding 是按谁的宽度算的，能用来做什么？",
    sources: [
      { repo: "FE-Interview", path: "summarry/" },
      { repo: "developer-roadmap", path: "src/" },
    ],
  },
  {
    id: "frontend-css-bfc",
    category: "frontend",
    topic: "CSS",
    difficulty: 2,
    tags: ["BFC", "浮动", "高度塌陷"],
    question: "什么是 BFC？它能解决哪些实际问题？",
    answer:
      "结论：BFC 是块级格式化上下文，一块独立布局区域，内部布局不影响外部，外部浮动也不会侵入。\n\n触发方式：根元素、float 不为 none、position 为 absolute 或 fixed、display 为 inline-block 或 flow-root、flex 与 grid 子项、overflow 不为 visible。\n\n能解决的问题：\n- 父元素高度塌陷：子元素浮动后父元素撑不开，给父元素加 display: flow-root 即可。\n- 相邻兄弟 margin 塌陷：把其中一个包进新的 BFC，两个 margin 就不再合并。\n- 文字环绕浮动元素：给文字容器建 BFC，它会避开浮动元素形成独立块。\n\n实践：优先用 display: flow-root，它是专为创建 BFC 设计的，不像 overflow: hidden 会裁剪溢出内容、影响阴影和滚动。排查布局问题时，在 DevTools 里看盒子的 Layout 面板有没有被浮动挤压，比猜更快。",
    points: ["独立布局区域，内外互不影响", "overflow、float、flow-root 可触发", "解决高度塌陷与 margin 塌陷"],
    follow: "flow-root 和 overflow: hidden 创建 BFC 的副作用差别在哪？",
    sources: [
      { repo: "FE-Interview", path: "summarry/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-css-flex-grid",
    category: "frontend",
    topic: "CSS",
    difficulty: 1,
    tags: ["flex", "grid", "布局"],
    question: "flex 布局里 flex: 1 展开是什么？子项为什么会被压缩？",
    answer:
      "结论：flex: 1 等于 flex-grow 为 1、flex-shrink 为 1、flex-basis 为 0%，意思是先按 0 基准分配全部剩余空间。\n\n机制：主轴先按 flex-basis 算出各项基准尺寸，空间有剩余就按 flex-grow 比例分；空间不够就按 flex-shrink 乘以基准尺寸加权收缩。basis 为 auto 时用元素自身宽度，为 0 时完全按比例分，这就是 flex: 1 各项等宽的原因。\n\n实践：\n- 子项被压扁通常是默认 flex-shrink 为 1，不想缩就设 flex-shrink: 0。\n- 文本省略号失效要补 min-width: 0，因为 flex 子项默认 min-width 是 auto，会被内容撑住。\n- 一维排列用 flex，二维行列对齐用 grid，grid 的 fr 单位天然按比例分剩余空间，间距用 gap 更省心。",
    points: ["flex 1 即 grow1 shrink1 basis0", "收缩按 flex-shrink 加权计算", "省略号失效要加 min-width 0"],
    follow: "flex 子项里 text-overflow: ellipsis 不生效，原因是什么？",
    sources: [
      { repo: "developer-roadmap", path: "src/" },
      { repo: "FE-Interview", path: "demos/" },
    ],
  },
  {
    id: "frontend-css-cascade-specificity",
    category: "frontend",
    topic: "CSS",
    difficulty: 2,
    tags: ["层叠", "优先级", "选择器"],
    question: "CSS 样式冲突时按什么顺序决定谁生效？",
    answer:
      "结论：先比来源与重要性，再比选择器特异性，最后比书写顺序，越靠后越优先。\n\n机制：特异性是个四元组，行内样式最高，之后依次是 id 数量、class 与属性选择器与伪类的数量、元素与伪元素的数量。同来源同权重时后写的覆盖先写的。重要性排序上，作者样式里的 !important 高于行内普通声明，用户样式表的 !important 又高于作者的 !important，动画声明排在两者之间。\n\n实践：\n- 现代写法更依赖层叠层，用 @layer 显式声明顺序，重置样式放最前，工具类居中，业务样式最后，不用靠 !important 硬顶。\n- 排查用 DevTools 的 Computed 面板，被划掉的声明会显示来源文件和行号，直接看到是谁覆盖的。\n- 选择器尽量控制在两层以内，嵌套过深既难覆盖也拖慢样式匹配。",
    points: ["来源与重要性优先于特异性", "特异性按 id、class、元素计数", "同权重看书写先后顺序"],
    follow: "继承来的样式和直接命中的样式冲突时，谁生效？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "developer-roadmap", path: "src/" },
    ],
  },
  {
    id: "frontend-browser-render-pipeline",
    category: "frontend",
    topic: "浏览器",
    difficulty: 2,
    tags: ["渲染流程", "合成", "关键渲染路径"],
    question: "从 HTML 到屏幕像素，浏览器经历了哪些阶段？",
    answer:
      "结论：解析、样式计算、布局、分层、绘制、合成六步，前四步在主线程，绘制之后的栅格化和合成交给合成线程与 GPU。\n\n机制：\n- HTML 解析成 DOM，CSS 解析成 CSSOM，两者合成渲染树；script 默认阻塞解析，所以要加 defer 或 async。\n- 样式计算把选择器匹配成计算值，布局算出每个盒子的几何位置，绘制生成绘制指令列表，再按层切成图块栅格化。\n- transform 和 opacity 的动画只走合成阶段，不触发重排重绘，所以最流畅；改 width、top 会走完整流程。\n\n实践：关键 CSS 内联、脚本 defer、动画优先用 transform 与 opacity，并可用 will-change 提前提升图层，但图层过多会吃显存、增加合成开销，用完要撤掉。",
    points: ["解析、样式、布局、绘制、合成", "script 阻塞解析需 defer", "transform 与 opacity 只走合成"],
    follow: "为什么 transform 动画比改 top 更流畅，代价是什么？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "FE-Interview", path: "summarry/" },
    ],
  },
  {
    id: "frontend-browser-reflow-repaint",
    category: "frontend",
    topic: "浏览器",
    difficulty: 2,
    tags: ["重排", "重绘", "强制同步布局"],
    question: "哪些操作会触发重排和重绘？怎么避免布局抖动？",
    answer:
      "结论：几何属性变化触发重排，重排之后必然重绘；只改颜色、背景、visibility 这类不影响布局的属性只重绘；transform 与 opacity 只触发合成。\n\n触发条件：增删 DOM、改 width 或 height 或 margin 或 padding 或 font-size、窗口尺寸变化，以及读取 offsetTop、scrollTop、clientWidth、getComputedStyle 这类布局属性。\n\n布局抖动的根源是读写交替：先写样式再读布局，浏览器为了给出正确值只能立刻重排一次，这就是强制同步布局，一次循环能触发几十次。\n\n实践：\n- 批量写、集中读，把读操作放最前；必须交错时用 requestAnimationFrame 把写推迟到下一帧。\n- 用 DocumentFragment 或一次性替换 DOM 减少插入次数。\n- 排查看 Performance 面板，紫色 Layout 区块和标红的 Forced reflow 就是它。",
    points: ["几何变化重排，颜色变化重绘", "读写交替造成强制同步布局", "批量读写并把写放进 rAF"],
    follow: "requestAnimationFrame 的回调在渲染流程的哪一步执行？",
    sources: [
      { repo: "FE-Interview", path: "summarry/" },
      { repo: "tech-interview-handbook", path: "apps/website/" },
    ],
  },
  {
    id: "frontend-browser-event-delegation",
    category: "frontend",
    topic: "浏览器",
    difficulty: 1,
    tags: ["事件委托", "事件流", "冒泡"],
    question: "事件委托的原理是什么？哪些事件不适合委托？",
    answer:
      "结论：利用事件冒泡，把监听器挂在父元素上，通过 event.target 判断真正触发的子元素。\n\n机制：DOM 事件流分捕获、目标、冒泡三个阶段，addEventListener 默认在冒泡阶段触发，所以父元素能收到子元素的事件。委托的好处是动态新增的子节点自动生效，且只注册一个监听器，省内存也少了绑定解绑的遗漏。\n\n不适用的情况：focus 与 blur 不冒泡，要用 focusin 与 focusout；mouseenter 与 mouseleave 也不冒泡；元素上的 scroll 不冒泡，只有 window 上的滚动能捕获到；mousemove 这类高频事件委托反而增加判断成本。\n\n实践：用 closest 找目标并判断是否越界，注意 stopPropagation 会截断冒泡让委托失效。React 从 17 起把事件统一挂到根容器，用的也是委托。",
    points: ["冒泡阶段由父元素统一监听", "用 target 或 closest 定位", "focus 与 scroll 等事件不冒泡"],
    follow: "React 的合成事件和原生事件在冒泡顺序上有什么区别？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "CS-Notes", path: "docs/" },
    ],
  },
  {
    id: "frontend-network-http-cache",
    category: "frontend",
    topic: "网络与缓存",
    difficulty: 2,
    tags: ["强缓存", "协商缓存", "缓存头"],
    question: "强缓存和协商缓存分别由哪些头控制，命中顺序是怎样的？",
    answer:
      "结论：先查强缓存，命中就直接用本地副本、不发请求；没命中再带协商字段去问服务器，返回 304 就继续用本地副本。\n\n机制：\n- 强缓存看 Cache-Control 的 max-age，单位是秒；no-cache 表示可以存但每次必须校验，no-store 完全不存，immutable 表示有效期内不校验。Expires 是 HTTP/1.0 的绝对时间，受客户端时钟影响，优先级低于 max-age。\n- 协商缓存用 Last-Modified 配 If-Modified-Since，或 ETag 配 If-None-Match。ETag 精度更高，能识别内容没变但修改时间变了的情况，优先级也更高。\n- 刷新行为不同：地址栏回车走强缓存，F5 会给主文档带上 max-age=0 强制校验，Ctrl 加 F5 相当于全量重取。\n\n实践：入口 HTML 用 no-cache 配 ETag，带 hash 的静态资源设一年 max-age 加 immutable。",
    points: ["max-age 命中时不发请求", "ETag 配 If-None-Match 做协商", "HTML 不缓存，静态资源长缓存"],
    follow: "为什么入口 HTML 不建议设置很长的 max-age？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "tech-interview-handbook", path: "apps/portal/" },
    ],
  },
  {
    id: "frontend-network-http2-websocket",
    category: "frontend",
    topic: "网络与缓存",
    difficulty: 3,
    tags: ["HTTP/2", "WebSocket", "多路复用"],
    question: "HTTP/2 解决了 HTTP/1.1 的哪些问题？它和 WebSocket 各自适合什么场景？",
    answer:
      "结论：HTTP/2 用二进制分帧和多路复用解决了队头阻塞与连接数限制，但它仍是请求响应模型，服务端不能主动推业务数据，实时双向通信要用 WebSocket。\n\n机制：\n- HTTP/1.1 一条连接同一时刻只能处理一个请求，浏览器同域最多约 6 条连接，于是有了雪碧图、域名分片这类优化手段。\n- HTTP/2 把请求拆成帧在同一条 TCP 连接上交错传输，还带 HPACK 头部压缩和服务端推送；但 TCP 层丢包会阻塞所有流，所以又有了基于 UDP 的 HTTP/3。\n- WebSocket 通过一次 HTTP 升级握手建立全双工长连接，之后每帧头部只有 2 到 14 字节，开销远小于轮询。\n\n实践：普通接口用 HTTP/2 就够，别再域名分片；聊天、协同编辑、行情推送用 WebSocket，配心跳保活和指数退避重连。",
    points: ["多路复用解决队头阻塞与连接数限制", "仍是请求响应模型，不能主动推", "WebSocket 升级握手后全双工"],
    follow: "WebSocket 断了怎么重连，心跳间隔一般设多久？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "developer-roadmap", path: "src/" },
    ],
  },
  {
    id: "frontend-network-cors-preflight",
    category: "frontend",
    topic: "网络与缓存",
    difficulty: 3,
    tags: ["CORS", "预检请求", "跨域"],
    question: "什么情况下会发 CORS 预检请求，预检失败怎么排查？",
    answer:
      "结论：跨域请求只要不是简单请求，浏览器就先发一个 OPTIONS 预检，问服务器允不允许，通过之后才发真实请求。\n\n简单请求的条件：方法是 GET、HEAD、POST 之一，请求头只含 Accept、Accept-Language、Content-Language、Content-Type 等安全头，且 Content-Type 只能是 text/plain、multipart/form-data、application/x-www-form-urlencoded。带自定义头、用 PUT 或 DELETE、发 JSON 都会触发预检。\n\n机制：预检响应要带 Access-Control-Allow-Origin、Access-Control-Allow-Methods、Access-Control-Allow-Headers，命中后浏览器按 Access-Control-Max-Age 缓存结果，Chrome 上限是 2 小时。带 Cookie 时必须回显具体来源且 Access-Control-Allow-Credentials 为 true，不能用星号。\n\n排查：看 Network 里那条 OPTIONS 的状态码和响应头，常见原因是网关没放行 OPTIONS、Allow-Headers 漏了自定义头、带凭证却回显了星号。",
    points: ["非简单请求先发 OPTIONS 预检", "响应要回显来源、方法、请求头", "带凭证时来源不能用星号"],
    follow: "跨域请求已经发出去了但响应被拦截，这算请求成功了吗？",
    sources: [
      { repo: "FE-Interview", path: "summarry/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-perf-first-paint",
    category: "frontend",
    topic: "性能优化",
    difficulty: 1,
    tags: ["首屏", "懒加载", "关键渲染路径"],
    question: "首屏加载慢，你会从哪些方面排查和优化？",
    answer:
      "结论：先量再改。用 Lighthouse 或 Performance 面板看 LCP、TTFB 和资源瀑布图，判断瓶颈在服务端响应、关键资源体积还是渲染阻塞。\n\n优化方向：\n- 网络层：开 HTTP/2 与 Brotli，静态资源上 CDN 并设长缓存，接口做聚合减少请求数。\n- 资源层：路由级代码分割配合动态 import，图片用 WebP 或 AVIF 加 srcset 与 loading 懒加载属性，首屏外的组件延迟加载。\n- 渲染层：关键 CSS 内联，非关键 CSS 异步加载，脚本加 defer，字体设 font-display: swap 避免文字长时间不可见。\n- 体验层：给骨架屏，用 preconnect 和 preload 提前建连、提前拉关键资源。\n\n排查重点看瀑布图里的长条是下载耗时还是等待耗时，等待久说明服务端或请求排队有问题，前端优化再多也没用。",
    points: ["先用 Lighthouse 定位瓶颈", "代码分割与图片懒加载", "内联关键 CSS 并 defer 脚本"],
    follow: "LCP 统计的到底是哪个时刻，怎么针对性优化？",
    sources: [
      { repo: "tech-interview-handbook", path: "apps/portal/" },
      { repo: "developer-roadmap", path: "src/" },
    ],
  },
  {
    id: "frontend-perf-long-task",
    category: "frontend",
    topic: "性能优化",
    difficulty: 3,
    tags: ["长任务", "INP", "时间切片"],
    question: "页面卡顿但内存和网络都正常，怎么定位长任务并优化？",
    answer:
      "结论：卡顿通常来自主线程被超过 50ms 的任务占满，用户输入得不到及时响应，对应指标是 INP。\n\n定位：Performance 面板录制操作过程，右上角标红三角的就是长任务，展开看哪个函数 Self Time 最高；线上可以用 PerformanceObserver 监听 longtask 采集。\n\n优化手段：\n- 时间切片：把大循环拆成小批次，用 requestIdleCallback 或 setTimeout 在帧间隙执行，保证单次执行在 50ms 以内。\n- 降低优先级：非紧急更新用 scheduler.postTask 或 startTransition 标记为可中断。\n- 移出主线程：大数据计算放 Web Worker，注意用 Transferable 对象转移所有权，避免结构化克隆的开销。\n- 减少渲染压力：长列表虚拟滚动，别在滚动回调里读布局属性。",
    points: ["长任务指超过 50ms 的主线程占用", "时间切片或 Worker 拆分", "线上用 longtask 与 INP 观测"],
    follow: "Web Worker 里能操作 DOM 吗，数据怎么传回来？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "tech-interview-handbook", path: "apps/website/" },
    ],
  },
  {
    id: "frontend-perf-memory-leak",
    category: "frontend",
    topic: "性能优化",
    difficulty: 2,
    tags: ["内存泄漏", "堆快照", "Detached DOM"],
    question: "怎么判断页面有没有内存泄漏，常见泄漏场景有哪些？",
    answer:
      "结论：反复操作同一个功能后，堆内存不回落、Detached DOM 数量持续增长，基本可以判定泄漏。\n\n定位方法：Memory 面板取操作前后两次堆快照，用 Comparison 视图看新增对象和 retained size；或者录一段 Allocation instrumentation on timeline，观察操作结束后是否还有未释放的分配。\n\n常见场景：\n- 事件监听或定时器没清除，回调闭包持有组件实例与 DOM。\n- 全局缓存只写不删，键是 DOM 节点时会连带整棵子树。\n- 观察者没断开：ResizeObserver、IntersectionObserver、MutationObserver 都要 disconnect。\n- 单页应用路由切换后旧页面仍被全局变量或未取消的请求回调引用。\n\n实践：组件卸载时统一清理副作用，用 WeakMap 存与 DOM 关联的元数据，避免在全局数组里堆节点。",
    points: ["对比两次堆快照看 retained size", "监听器定时器观察者都要清理", "用 WeakMap 避免强引用"],
    follow: "WeakMap 和 Map 在垃圾回收上的区别是什么？",
    sources: [
      { repo: "FE-Interview", path: "summarry/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-framework-vue-reactivity",
    category: "frontend",
    topic: "框架原理",
    difficulty: 3,
    tags: ["Vue3", "响应式", "Proxy"],
    question: "Vue 3 的响应式是怎么实现的，和 Vue 2 有什么区别？",
    answer:
      "结论：Vue 3 用 Proxy 代理整个对象，读时收集依赖、写时触发更新；Vue 2 用 Object.defineProperty 逐个属性改写 getter 与 setter。\n\n差异：\n- 拦截范围：Proxy 能拦截新增与删除属性、数组索引赋值、length 修改、in 判断等十余种操作，Vue 2 这些都得靠 $set 或重写数组方法打补丁。\n- 惰性递归：Vue 3 在属性被访问时才代理子对象，初始化不用深度遍历，大对象首屏更快。\n- 依赖管理：每个属性对应一个依赖集合，渲染副作用作为订阅者，靠 track 收集、trigger 派发，只有渲染时真正读到的数据才建立依赖。\n\n实践：解构 reactive 对象会丢响应性，要用 toRefs；不需要深层响应就用 shallowRef 降开销；排查更新异常时，先确认数据是不是响应式对象、有没有在渲染中被读到。",
    points: ["Proxy 代理整对象，defineProperty 逐属性", "可拦截增删属性与数组索引", "读时 track 写时 trigger，惰性递归"],
    follow: "ref 和 reactive 有什么区别，为什么解构 reactive 会丢响应性？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "FE-Interview", path: "summarry/" },
    ],
  },
  {
    id: "frontend-framework-virtual-dom-diff",
    category: "frontend",
    topic: "框架原理",
    difficulty: 2,
    tags: ["虚拟DOM", "diff", "key"],
    question: "虚拟 DOM 的 diff 为什么能做到 O(n)？key 起什么作用？",
    answer:
      "结论：真实 DOM 树两两比较是 O(n³)，虚拟 DOM 用同层比较加类型判断把复杂度降到 O(n)，代价是放弃了跨层级移动的最优解。\n\n策略：只比较同一层级；类型不同直接整棵替换；类型相同则复用真实节点、只更新变化的属性，再配合双端比较或最长递增子序列减少节点移动次数。\n\nkey 的作用：列表 diff 时靠 key 判断新旧节点是不是同一个，没有 key 就只能按索引匹配。用索引当 key 时，头部插入一条会让所有项错位复用，出现输入框内容串位、动画错乱、组件内部状态残留。正确的 key 要稳定且唯一，用业务 id，别用 index，更别用随机数，随机 key 会让每次渲染都全量重建，比不写还慢。",
    points: ["同层比较把复杂度降到 O(n)", "类型不同整树替换，相同则复用", "key 要稳定唯一，不能用索引"],
    follow: "用 index 当 key 具体会出现什么可复现的 bug？",
    sources: [
      { repo: "FE-Interview", path: "summarry/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-framework-react-hooks-rules",
    category: "frontend",
    topic: "框架原理",
    difficulty: 2,
    tags: ["React Hooks", "闭包陷阱", "依赖数组"],
    question: "Hooks 为什么不能写在条件语句里？闭包陷阱是怎么回事？",
    answer:
      "结论：React 靠调用顺序把 Hook 和所在的 fiber 关联，内部是一条没有名字的链表，顺序一变状态就错位；闭包陷阱则是函数组件每次渲染都拥有自己的 props 与 state 快照。\n\n机制：首次渲染按顺序把状态挂到 memoizedState 链表上，更新时按同样顺序读取。某个 Hook 被 if 跳过，后面所有 Hook 读到的都是别人的状态，直接报 Hooks 数量不一致。所以规则是只在函数组件顶层和自定义 Hook 顶层调用。\n\n闭包陷阱：定时器或事件回调捕获的是创建那次渲染的变量，之后不再更新。解法是把依赖写进 useEffect 依赖数组、用函数式更新 setCount(c => c + 1)，或者用 useRef 保存最新值。\n\n实践：依赖数组别撒谎，用到的值都列上；既要最新值又不想重订阅，就用 ref 当桥梁。",
    points: ["Hook 按调用顺序与 fiber 关联", "顺序变化导致状态错位", "回调捕获渲染快照，用 ref 或函数式更新"],
    follow: "useEffect 依赖数组写空和完全不写，行为有什么区别？",
    sources: [
      { repo: "tech-interview-handbook", path: "apps/portal/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-engineering-tree-shaking",
    category: "frontend",
    topic: "工程化",
    difficulty: 3,
    tags: ["tree-shaking", "ESM", "sideEffects"],
    question: "tree-shaking 的原理是什么，为什么有时候摇了没效果？",
    answer:
      "结论：tree-shaking 依赖 ES Module 的静态结构，打包器在编译阶段就能确定导入导出关系，把没被引用的导出标记并删除；CommonJS 的 require 是运行时求值，做不到。\n\n没效果的原因：\n- 模块被转成 CommonJS，静态分析失效，比如 Babel 的 modules 选项设成了 commonjs。\n- 副作用误判：打包器不敢删可能有副作用的模块，需要在 package.json 里声明 sideEffects 字段，把纯模块标成 false。\n- 写法不友好：先导出对象再整体引用、用计算属性访问导出，分析器只能认为全部被用到。\n- 只删代码不删副作用：模块顶层立即执行的语句、给原型打补丁、引入全局 CSS 都会被保留。\n\n实践：产出同时提供 ESM 入口，用 import 而不是 require，配好 sideEffects，再用打包分析器确认模块有没有真的被剔除。",
    points: ["依赖 ESM 静态结构做分析", "转成 CommonJS 会让分析失效", "sideEffects 字段决定能否删除"],
    follow: "sideEffects 设成 false 有什么风险，哪些文件要列白名单？",
    sources: [
      { repo: "web-interview", path: "docs/" },
      { repo: "developer-roadmap", path: "src/" },
    ],
  },
  {
    id: "frontend-engineering-module-monorepo",
    category: "frontend",
    topic: "工程化",
    difficulty: 1,
    tags: ["模块规范", "monorepo", "pnpm"],
    question: "ESM 和 CommonJS 有什么区别？多个包共享代码怎么组织？",
    answer:
      "结论：CommonJS 是运行时同步加载，导出的是值的拷贝；ESM 是编译期静态解析，导出的是值的引用，并且默认严格模式、支持顶层 await。\n\n差异：\n- 加载时机：require 能写在条件语句里，import 会被提升到模块顶部先执行。\n- 循环依赖：CommonJS 拿到的是没执行完的部分导出，可能是 undefined；ESM 靠实时绑定，只要访问时机在使用之后就能拿到值。\n- 浏览器原生支持 ESM，用 type 为 module 的 script 加载，自动 defer 且作用域隔离。\n\n实践：库同时产出 ESM 与 CJS 双格式，在 package.json 的 exports 字段里做条件导出；多包共享代码用 pnpm workspace 组织 monorepo，包之间用 workspace 协议直接引用源码，配合 changesets 管理版本与发布，公共构建配置抽成独立包统一维护。",
    points: ["CJS 运行时值拷贝，ESM 静态引用", "ESM 有提升、严格模式、顶层 await", "monorepo 用 workspace 组织"],
    follow: "pnpm 的软链接结构是怎么解决幽灵依赖的？",
    sources: [
      { repo: "developer-roadmap", path: "src/" },
      { repo: "FE-Interview", path: "summarry/" },
    ],
  },
  {
    id: "frontend-security-xss",
    category: "frontend",
    topic: "安全",
    difficulty: 2,
    tags: ["XSS", "转义", "CSP"],
    question: "XSS 有哪几种类型，防御的关键点是什么？",
    answer:
      "结论：分存储型、反射型、DOM 型三类。存储型危害最大，恶意脚本被存进数据库，所有访问该页面的用户都会中招；反射型靠诱导点击带参链接；DOM 型不经过服务端，前端直接把不可信数据写进 innerHTML 或 eval。\n\n防御：\n- 输出转义是根本，要按上下文选规则，HTML 内容、属性、URL、JS 上下文各不相同。\n- 避免危险 API：不用 innerHTML、outerHTML、document.write，必须渲染富文本时用 DOMPurify 做白名单过滤。\n- 加 CSP 响应头限制脚本来源，禁止内联脚本，用 nonce 或 hash 放行必要的内联代码。\n- Cookie 加 HttpOnly，脚本读不到就偷不走；SameSite 设为 Lax 或 Strict 缓解跨站请求。\n\n实践：框架默认转义插值，真正的风险点是 v-html、dangerouslySetInnerHTML 和直接拼 URL 的地方，Code Review 重点看这些。",
    points: ["分存储型、反射型、DOM 型三类", "按上下文转义并禁用 innerHTML", "CSP 与 HttpOnly 兜底"],
    follow: "CSP 开了之后内联脚本全失效，怎么兼容老代码？",
    sources: [
      { repo: "CS-Notes", path: "docs/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-security-csrf",
    category: "frontend",
    topic: "安全",
    difficulty: 2,
    tags: ["CSRF", "SameSite", "同源策略"],
    question: "CSRF 是怎么发生的？SameSite 和 CSRF Token 各自防住了什么？",
    answer:
      "结论：CSRF 利用的是浏览器会自动带上目标站点的 Cookie，攻击者在自己的页面上伪造请求，服务端分不清是不是用户本意。\n\n机制：同源策略只限制脚本读取跨站响应，不限制请求发出，表单提交、img 的 src、a 跳转都能跨站发起，所以带 Cookie 的写操作会被执行。\n\n防御：\n- SameSite 是最省事的一道墙，Lax 允许顶级导航的 GET 带 Cookie，跨站 POST 不带；Strict 更严格，但会影响从外站跳回来的登录态。\n- CSRF Token 校验请求里带的一次性令牌，攻击者拿不到，适合表单和接口。\n- 还可以校验 Origin 或 Referer 头，或用双提交 Cookie 把令牌同时放在 Cookie 与请求头里比对。\n\n实践：别用 GET 做状态变更，接口统一要求自定义头并收紧 CORS 来源，敏感操作加二次验证。",
    points: ["浏览器自动带 Cookie 是根因", "SameSite 限制跨站携带 Cookie", "Token 校验请求确实来自本站"],
    follow: "同源策略挡不住 CSRF，它到底限制了哪些行为？",
    sources: [
      { repo: "CS-Notes", path: "docs/" },
      { repo: "tech-interview-handbook", path: "apps/portal/" },
    ],
  },
  {
    id: "frontend-handwrite-debounce-throttle",
    category: "frontend",
    topic: "手写代码",
    difficulty: 1,
    tags: ["防抖", "节流", "手写"],
    question: "手写一个防抖函数，并说明它和节流的适用场景。",
    answer:
      "结论：防抖是等停止触发一段时间后才执行，节流是固定频率执行一次。\n\n实现思路：防抖用定时器，每次调用先清掉上一个再重设；需要首次立即执行，就先判断定时器是否存在，存在说明还在等待期。节流用时间戳记录上次执行时间，或者用定时器加标志位保证冷却期内不再执行。\n\n```js\nfunction debounce(fn, wait) {\n  let timer = null;\n  return function (...args) {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn.apply(this, args), wait);\n  };\n}\n```\n\n场景：搜索联想、表单校验、窗口 resize 结束后的重算用防抖；滚动加载、鼠标移动、拖拽跟随、按钮防连点用节流。两者都要在组件卸载时清除定时器，否则既泄漏内存，又可能在组件销毁后触发回调。",
    points: ["防抖等停止，节流按频率", "防抖清定时器，节流记时间戳", "卸载时要清理定时器"],
    follow: "防抖函数怎么支持首次立即执行和手动取消？",
    sources: [
      { repo: "FE-Interview", path: "demos/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
  {
    id: "frontend-handwrite-deep-clone",
    category: "frontend",
    topic: "手写代码",
    difficulty: 2,
    tags: ["深拷贝", "循环引用", "手写"],
    question: "手写深拷贝要考虑哪些边界情况？",
    answer:
      "结论：至少要处理循环引用、Date 与 RegExp 等内置类型、Map 与 Set、原型链和不可枚举属性。\n\n思路：用 WeakMap 记录已拷贝过的对象，遇到重复引用直接返回缓存，既解决循环引用也避免重复拷贝；先用 typeof 与 Object.prototype.toString 判断类型，非对象或 null 直接返回；Date 用新实例重建，Map 与 Set 逐个遍历递归拷贝，数组要保持数组类型。\n\n```js\nfunction clone(value, seen = new WeakMap()) {\n  if (value === null || typeof value !== 'object') return value;\n  if (seen.has(value)) return seen.get(value);\n  const copy = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));\n  seen.set(value, copy);\n  for (const key of Reflect.ownKeys(value)) copy[key] = clone(value[key], seen);\n  return copy;\n}\n```\n\n实践：纯数据优先用原生 structuredClone，它支持循环引用，但不支持函数、DOM 节点和自定义原型；含函数与复杂类型用 lodash 的 cloneDeep；JSON 方案会丢 undefined、函数、Symbol，还会把 Date 变成字符串，只适合纯 JSON 数据。",
    points: ["WeakMap 解决循环引用", "区分 Date、Map、Set 等类型", "structuredClone 与 JSON 方案的局限"],
    follow: "JSON.parse 配 JSON.stringify 会丢失哪些东西？",
    sources: [
      { repo: "FE-Interview", path: "summarry/" },
      { repo: "web-interview", path: "docs/" },
    ],
  },
];
