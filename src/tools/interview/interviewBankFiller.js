// 面试题库 · 补充分片（薄主题补齐）。
//
// 为什么单独一份：`interviewBank.test.js` 有一条断言「每个主题下至少两道题」——
// 只有一道题的主题，用户点开筛选等于没筛。这个文件专门收那些一时凑不满两道的主题，
// 后续某个主题长到足够多时，可以把它的题挪回对应方向的分片里，这个文件就空着。
//
// 目前补五处：虚拟线程（JDK 21 的工程取舍）、MyBatis（执行流程与缓存）、
// 可观测性（告警设计，而不是又一道「怎么排查」）、安全与权限（越权而非鉴权）、
// 可访问性与体验（无障碍的工程理由而非清单）。

export const FILLER_QUESTIONS = [
  {
    id: "backend-concurrent-virtual-thread-pinning",
    category: "backend",
    topic: "虚拟线程",
    difficulty: 3,
    tags: ["虚拟线程", "Loom", "synchronized", "pin"],
    question: "虚拟线程遇到 synchronized 会被「钉住」，这是什么意思、怎么办？",
    answer: `虚拟线程由 JVM 调度，阻塞在**可被识别的阻塞点**（网络 IO、Thread.sleep、锁的 park）时会卸载载体线程，让载体去跑别的虚拟线程。但有两类情况卸载不了，载体线程被占住，就叫钉住（pinning）：

- 在 \`synchronized\` 块里阻塞：monitor 与载体线程绑定，JDK 21 之前无法卸载。JDK 24 起（JEP 491）已解决，21/22 上仍要小心。
- 调用 native 方法或 foreign function 时阻塞。

钉住的危害不是「报错」，而是**载体线程池被悄悄占满**：默认载体池大小等于 CPU 核数，几个钉住的虚拟线程就能让整批任务排队，表现为吞吐突然塌掉而 CPU 不高。

排查用 \`-Djdk.tracePinnedThreads=full\`（JDK 21）或 JFR 的 \`jdk.VirtualThreadPinned\` 事件，它会直接打出钉住的调用栈。

对策：把热点路径上的 \`synchronized\` 换成 \`ReentrantLock\`；实在换不掉就缩小临界区，别在锁里做 IO。`,
    points: ["钉住=载体线程无法卸载", "synchronized 与 native 调用是两大来源", "用 tracePinnedThreads 或 JFR 定位"],
    follow: "那虚拟线程适合用在什么场景、不适合什么场景？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "JavaGuide", path: "docs/java/new-features/" }],
  },
  {
    id: "backend-spring-mybatis-execution-flow",
    category: "backend",
    topic: "MyBatis",
    difficulty: 2,
    tags: ["MyBatis", "SqlSession", "一级缓存", "Executor"],
    question: "MyBatis 一条 SQL 的执行流程是怎样的？一级缓存为什么会踩坑？",
    answer: `流程：\`SqlSession\` 拿到 \`Executor\` → 查缓存 → 命中直接返回，未命中则由 \`StatementHandler\` 通过 \`ParameterHandler\` 设置参数、执行 JDBC、再由 \`ResultSetHandler\` 把结果映射成对象。插件（Interceptor）就挂在这四个组件上，所以分页、SQL 打印都靠它。

一级缓存是 \`SqlSession\` 级别的 \`PerpetualCache\`，默认开启，作用域**就是一次会话**。它踩坑的根因是「同一个 SqlSession 里第二次相同查询直接返回旧值」：

- 在 Spring 里如果没配事务，每次 Mapper 调用都是新 SqlSession，缓存几乎不生效，看起来没问题；
- 一旦加上 \`@Transactional\`，整个事务共用一个 SqlSession，此时**别处改了数据但没经过本会话**，再查同一条 SQL 就会读到陈旧结果。

失效条件记牢：执行 update/insert/delete、事务提交或回滚、手动 \`clearCache()\`、以及 \`localCacheScope\` 设为 STATEMENT。

二级缓存是 namespace 级、跨会话的，默认关闭。多表关联时它的失效粒度是 namespace，很容易脏，线上一般不轻易开。`,
    points: ["Executor→StatementHandler→ResultSetHandler", "一级缓存作用域是一次 SqlSession", "事务内复用会话会让缓存读到旧值"],
    follow: "二级缓存为什么在多表关联时容易脏？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/framework/mybatis/" }, { repo: "JavaGuide", path: "docs/system-design/framework/spring/" }],
  },
  {
    id: "system-observability-alert-design",
    category: "system",
    topic: "可观测性",
    difficulty: 3,
    tags: ["告警", "SLO", "误报", "MTTR"],
    question: "告警总是要么太吵要么漏报，怎么设计才可用？",
    answer: `把告警从「指标越界」改成「**用户承诺被破坏**」：先定 SLO（比如核心接口 99.9% 请求 <300ms、月度错误预算 0.1%），再用**错误预算消耗速率**触发告警，而不是给每个指标配一个静态阈值。

- 快燃（2% 预算在 1 小时内烧完）→ 立刻叫人；
- 慢燃（10% 预算在 6 小时内烧完）→ 进工单，不打断人。
同一套预算两条曲线，天然区分了「真故障」与「慢慢变差」。

降噪的三个具体手段：
- **多窗口比对**：短窗口超阈值 + 长窗口也超，才发（单窗口抖动直接过滤）；
- **分组与聚合**：按服务 + 接口聚合，别让一台机器的 200 个实例各发一条；
- **分级路由**：P0 打电话、P1 进群、P2 只进工单，并且每条告警都必须有人能说出「收到后做什么」，说不出就删掉。

漏报通常来自两个地方：只监控了入口而没监控下游依赖（下游挂了入口还没超时），以及只监控成功率没监控**量**（流量掉到 0 时成功率是 100%）。补一条「请求量同比骤降」和「依赖调用失败率」基本能覆盖。`,
    points: ["先定 SLO 再用错误预算速率告警", "快燃叫人、慢燃进工单", "补流量骤降与依赖失败率防漏报"],
    follow: "错误预算烧完了应该做什么？",
    sources: [{ repo: "system-design-primer", path: "solutions/system_design/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "system-b-security-horizontal-privilege-escalation",
    category: "system",
    topic: "安全与权限",
    difficulty: 2,
    tags: ["越权", "水平越权", "鉴权", "数据权限"],
    question: "接口鉴权做了，为什么还会出现「看到别人的订单」？怎么系统性防住？",
    answer: `这是**水平越权**：身份验证（你是谁）做对了，但**授权**（你能碰哪条数据）没做。典型形态是接口只校验登录态，然后直接按前端传来的 \`orderId\` 查库，谁把 id 改一下就能读别人的单子。

它和垂直越权（普通用户调管理员接口）是两件事，防护手段也不同：

- **垂直越权**靠角色/权限点校验，通常能在网关或统一拦截器解决；
- **水平越权**必须在**数据访问层**解决，因为「这条数据属不属于当前用户」只有业务知道。

系统性防住靠三条：

1. **数据权限下沉到 DAO**：查询条件强制带上当前用户维度（\`where id = ? and user_id = ?\`），而不是查出来再在 Service 里 if 判断——后者漏一个分支就破防。
2. **用不可枚举的标识**：对外暴露 id 用 UUID 或加签的短码，避免自增 id 被顺序遍历。这只提高成本，不能替代第 1 条。
3. **统一拦截 + 用例覆盖**：把「越权返回 404 而不是 403」写成约定（403 会泄露资源存在性），并对每个涉及资源的接口补一条「换个用户请求应失败」的测试。

排查现网时最有效的手段是**审计日志 + 参数异常检测**：同一账号短时间内遍历大量不同资源 id，是最典型的越权特征。`,
    points: ["区分水平越权与垂直越权", "数据权限必须下沉到查询条件", "越权返回 404 且要有用例覆盖"],
    follow: "为什么越权要返回 404 而不是 403？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/security/" }, { repo: "system-design-primer", path: "solutions/system_design/" }],
  },
  {
    id: "frontend-c-a11y-engineering-requirement",
    category: "frontend",
    topic: "可访问性与体验",
    difficulty: 1,
    tags: ["无障碍", "aria", "语义化", "键盘可达"],
    question: "无障碍在前端为什么是工程要求而不是加分项？日常怎么做最划算？",
    answer: `因为它同时是**合规要求**与**质量信号**：不少行业（政务、金融、面向欧美的产品）有强制标准（WCAG 2.1 AA、国内的无障碍规范），而更实际的是——无障碍做得好的页面，键盘可用性、焦点管理、语义结构通常也都是对的，屏幕阅读器能读懂的界面，自动化测试与搜索引擎同样能读懂。

日常最划算的三件事，成本低、收益立刻可见：

- **用对语义标签**：该用 \`button\` 就别用 \`div\` 加 click。原生元素自带键盘响应、焦点、角色与状态，手写这些的成本远高于直接用对的标签。同理表单要配 \`label\`。
- **保证键盘可达与焦点可见**：所有交互元素能 Tab 到、能 Enter/Space 触发，且 \`:focus-visible\` 有明显的视觉反馈。**不要**为了「好看」写 \`outline: none\` 而不给替代样式——这是最常见的破防点。
- **模态框要管住焦点**：打开时把焦点移进去、Tab 循环限制在框内、关闭后焦点还给触发元素，并且 \`Esc\` 能关。用 \`aria-modal\` 与 \`role="dialog"\` 声明，别只靠一层遮罩。

检查手段：键盘走一遍主流程、Chrome DevTools 的 Lighthouse 无障碍审计、以及 axe DevTools 扩展。真正的验收是**只用键盘 + 只用屏幕阅读器**各跑通一次核心流程。`,
    points: ["无障碍是合规要求也是质量信号", "用原生语义标签而不是 div 模拟", "键盘可达、焦点可见、模态管焦点"],
    follow: "aria-label 和 label 什么时候该用哪个？",
    sources: [{ repo: "developer-roadmap", path: "src/" }, { repo: "tech-interview-handbook", path: "apps/portal/" }],
  },
];
