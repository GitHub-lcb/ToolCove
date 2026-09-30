// 面试题库 · 系统设计 · 经典设计题与工程实践。
// 本文件只负责系统设计里「能画出来、能算清楚、能上线」的那一类题：经典设计题（限流、IM、
// 排行榜、调度、网盘、库存扣减）、分布式与一致性、数据与存储、运维与发布、安全与权限，
// 与 interviewBankSystem.js 互补——那边偏缓存/高并发/可用性等机制原理，这边偏整体方案与取舍。
// 来源引用约定：sources 只写「仓库名 + 仓库内相对路径」，不写完整 URL，便于离线检索与追溯；
// repo 仅取 system-design-primer、advanced-java、JavaGuide、CS-Notes、tech-interview-handbook
// 五个开源仓库，path 必须是该仓库中真实存在的路径前缀。
export const SYSTEM_B_QUESTIONS = [
  {
    id: "system-b-design-rate-limiter",
    category: "system",
    topic: "经典设计题",
    difficulty: 1,
    tags: ["限流", "令牌桶", "Redis"],
    question: "设计一个分布式限流器，集群总阈值一百万 QPS，怎么做才准又不拖慢接口？",
    answer: `结论：网关侧做两级限流，本地令牌桶兜突发，Redis 管全局配额，逻辑必须下沉到网关。

- 方案一 Redis 加 Lua 脚本：把取令牌写成脚本，key 用 rate_limit:api:秒级时间戳，Lua 在 Redis 单线程里执行天然原子，一次调用 1ms 以内。代价是每个请求一次网络往返，单分片十万 QPS 就到顶，热点 key 还会集中到一个分片。
- 方案二 本地限流加配额分配：每台机器本地令牌桶，由中心每 100ms 下发一次额度。延迟几乎为零，Redis 挂了能降级成单机限流；代价是精度差，误差约等于单机份额，节点越多越不准。

生产上常用组合拳：本地桶吸收突发，Redis 只做全局兜底，超时设 50ms，超时就直接放行。监控限流触发率、Redis 调用延迟和误杀率，误杀率超过千分之一说明阈值定低了，Redis 响应超过 50ms 或错误率超过百分之一就立即降级到本地限流。`,
    points: ["两级限流：本地兜突发加 Redis 全局", "Lua 保证原子性与 50ms 超时", "误杀率与降级开关"],
    follow: "如果 Redis 集群整体故障，你的限流器怎么保证接口不被压垮？",
    sources: [
      { repo: "system-design-primer", path: "solutions/system_design/" },
      { repo: "advanced-java", path: "docs/high-concurrency/" },
    ],
  },
  {
    id: "system-b-design-im-message-system",
    category: "system",
    topic: "经典设计题",
    difficulty: 3,
    tags: ["IM", "长连接", "消息有序"],
    question: "设计一个 IM 消息系统，重点讲在线状态、离线消息和消息有序怎么保证？",
    answer: `结论：拆成三块——连接层管在线状态，存储层管离线消息，会话层管顺序号，取舍完全不同。

- 连接：WebSocket 网关，用一致性哈希把同一用户固定到一个节点，本地维护在线表。代价是节点故障会掉一批连接，客户端必须带指数退避重连，退避上限 30s。
- 离线消息：不落离线表，改写收件箱。在线走推送，离线写 Redis List 只留最近 1000 条，更早的按 user_id 加 seq 分片落 MySQL，代价是存储翻倍。
- 有序：每个会话维护单调递增 seq，服务端在单会话维度串行写入保证顺序，客户端按 seq 排序去重；发现 seq 断层就主动拉取缺失区间补洞。

坑在于离线消息无限堆积，超过阈值只保留最近 7 天或 1000 条，否则单用户能占几百 MB。多端登录时已读位点要按设备维度记。监控连接数、重连率、端到端延迟 P99 和 seq 断层告警数，延迟 P99 超过 500ms 就要查网关推送队列。`,
    points: ["连接层用一致性哈希固定用户", "收件箱模型替代离线表", "会话级 seq 排序加断层补洞"],
    follow: "群聊消息有几万人的大群，你的写扩散方案怎么改？",
    sources: [
      { repo: "system-design-primer", path: "solutions/system_design/" },
      { repo: "CS-Notes", path: "docs/" },
    ],
  },
  {
    id: "system-b-design-leaderboard-counter",
    category: "system",
    topic: "经典设计题",
    difficulty: 2,
    tags: ["排行榜", "ZSet", "计数器"],
    question: "设计一个实时排行榜，千万用户参与，怎么存、怎么查、怎么防刷？",
    answer: `结论：Redis ZSet 是默认答案，score 存分数、member 存用户 ID，底层跳表让排名和范围查询都是 O(log N)。

- 大 key 的代价：千万 member 的单个 ZSet 内存几个 GB，主从同步和持久化都被拖慢。按榜单维度分片（日榜、周榜各一个 ZSet），单个控制在 100 万 member 以内。
- 深分页的代价：ZREVRANGE 复杂度是 O(log N 加 M)，翻到几千页依然拖住 Redis。只开放前 100 名，个人名次单独用 ZREVRANK 查，不要靠翻页逼近。
- 榜单合并：多分片出总榜要归并取 Top K，别用 ZUNIONSTORE 全量合并，那是 O(N) 且阻塞。

防刷靠限制单用户分数增速（1 分钟最多涨 100 分）加离线清洗异常账号。监控 ZSet 基数、内存占用和写入 QPS，单个 ZSet 内存超过 1GB 就分片，或改用 HBase 加定时快照。`,
    points: ["ZSet 跳表的复杂度与适用性", "大 key 与深分页的具体代价", "限速防刷与内存水位监控"],
    follow: "如果榜单要支持按多个维度组合排名，ZSet 还够用吗？",
    sources: [
      { repo: "system-design-primer", path: "solutions/system_design/sales_rank/" },
      { repo: "JavaGuide", path: "docs/database/redis/" },
    ],
  },
  {
    id: "system-b-design-scheduler",
    category: "system",
    topic: "经典设计题",
    difficulty: 3,
    tags: ["定时任务", "选主", "分片"],
    question: "设计一个分布式定时任务调度，怎么保证任务不重复执行也不漏执行？",
    answer: `结论：用 DB 或 ZooKeeper 做选主加分片，靠乐观锁防重，靠补偿扫描防漏。

- 选主加抢占：每个任务在调度表登记 cron、状态和版本号，触发前先 CAS 抢执行权，UPDATE 带 version 条件、影响行数为 1 才算抢到。代价是依赖 DB 可用性，DB 抖动会漏触发。
- 分片执行：把任务切成 N 片分给各执行器，规则用 executorId 对 N 取模，保证同一片固定落在同一台机器。扩容时 N 变了会重新分配，要求任务本身幂等。
- 取舍：抢占式实现简单但有脑裂风险，要靠 DB 锁加续租兜住；一致性协调方案更稳，代价是多一个组件。

最大的坑是任务必须幂等，网络抖动和 GC 停顿都会导致重复触发，业务侧要用唯一键或状态机保证重复执行无副作用。调度时间统一用 DB 或 NTP 时间，别用本机时钟。监控执行失败率、超时次数和漏触发补偿次数，同一任务连续失败 3 次告警，执行超过超时阈值 2 倍就标记失败。`,
    points: ["CAS 抢占执行权防重复", "分片取模与扩容重分配", "幂等是最后一道防线"],
    follow: "任务执行到一半调度器挂了，重启后怎么保证不漏？",
    sources: [
      { repo: "JavaGuide", path: "docs/system-design/schedule-task.md" },
      { repo: "advanced-java", path: "docs/distributed-system/" },
    ],
  },
  {
    id: "system-b-design-file-storage",
    category: "system",
    topic: "经典设计题",
    difficulty: 2,
    tags: ["分片上传", "秒传", "断点续传"],
    question: "设计一个网盘的文件上传，秒传、分片和断点续传分别怎么实现？",
    answer: `结论：客户端算 MD5 去重，分片上传加服务端合并，秒传就是命中已有文件直接建引用。

- 秒传：先拿文件 MD5 查元数据表，命中就建一条引用记录，不传字节。代价是物理文件要引用计数，删除时计数减 1、归零才真删，否则会误删还在被引用的文件。
- 分片：按 5MB 切片并发上传，每片单独算 MD5。片太小请求数爆炸，片太大重传成本高，5MB 是常见折中。
- 断点续传：元数据表记 file_id、分片总数、已上传分片位图和状态，客户端上传前先问已传了哪些片，只补缺失的，最后调合并接口按序拼接并校验整体 MD5。

坑在于 MD5 可被恶意构造碰撞，单用它做去重键会越权拿到别人的文件，所以要用 MD5 加文件大小加首尾字节采样组合成去重键。临时分片要定期清理，超过 24 小时未合并的自动删除。合并是 CPU 与 IO 密集操作，交给对象存储的分片上传接口做。监控合并成功率、平均分片数和秒传命中率。`,
    points: ["秒传的引用计数与删除代价", "位图记录分片支持续传", "MD5 碰撞与临时分片清理"],
    follow: "引用计数算错了，怎么发现并修复已经被误删的文件？",
    sources: [
      { repo: "system-design-primer", path: "solutions/system_design/pastebin/" },
      { repo: "tech-interview-handbook", path: "apps/portal/" },
    ],
  },
  {
    id: "system-b-design-inventory-deduction",
    category: "system",
    topic: "经典设计题",
    difficulty: 3,
    tags: ["防超卖", "库存扣减", "幂等"],
    question: "设计优惠券领取和库存扣减，怎么防超卖又防同一用户重复领取？",
    answer: `结论：库存用 Redis 预扣加 MQ 异步落库，防重复领取靠数据库唯一索引兜底，两者必须同时存在。

- 方案一 纯 DB 乐观锁：UPDATE stock SET count = count - 1 WHERE sku_id = ? AND count > 0，靠影响行数判断是否成功，一致性最强。代价是热点行竞争严重，同一 SKU 并发超过 5000 时 TPS 掉到几百。
- 方案二 Redis 预扣加异步落库：先 SETNX 防重复，再用 Lua 原子扣减，成功写 MQ，DB 侧异步条件更新。吞吐能到十万级，代价是 Redis 与 DB 可能不一致，必须配对账和回滚。

坑在于超卖往往来自先查再扣的两步操作，检查和扣减不在一个原子操作里就一定会超。防重复领取最终要靠唯一索引兜底。回滚要有补偿任务，MQ 消费失败或 DB 扣减失败时把 Redis 库存加回去。监控 Redis 与 DB 的库存差值和扣减失败率。`,
    points: ["先查再扣是超卖根因", "唯一索引兜住重复领取", "Redis 预扣必须配对账补偿"],
    follow: "Redis 库存扣成功了但 MQ 消息丢了，这笔订单最后怎么收场？",
    sources: [
      { repo: "system-design-primer", path: "solutions/system_design/" },
      { repo: "advanced-java", path: "docs/high-concurrency/" },
    ],
  },
  {
    id: "system-b-consistency-eventual-reconcile",
    category: "system",
    topic: "分布式与一致性",
    difficulty: 3,
    tags: ["最终一致", "对账", "本地消息表"],
    question: "两个服务之间怎么做到最终一致，对账又该怎么设计？",
    answer: `结论：优先本地消息表加定时对账，不追求强一致，对账是最后一道防线，没有对账的最终一致都是嘴上说说。

- 本地消息表：业务数据和消息记录在同一个本地事务里落库，再由定时任务投递 MQ，消费方做幂等。代价是投递有秒级延迟，且消息表会膨胀，需要按天归档。
- TCC 或 Saga：TCC 要求每个参与方实现 try、confirm、cancel 三段，一致性更强，适合资金类业务；代价是开发成本高，cancel 要考虑空回滚和悬挂。Saga 用补偿事务，实现简单但补偿逻辑可能失败，必须有人工介入通道。

对账的做法：每天凌晨跑离线任务，把双方流水按业务单号和金额逐笔比对，差异分三类——我方有对方无、对方有我方无、金额不等，分别走补单、冲正、人工工单。

坑在于对账不能只对总额，总额相等但两笔互相抵消的错误会被完全掩盖，必须对到单笔。监控差异单量、补单成功率、消息投递延迟；差异单占比超过万分之一或补单连续失败 3 次就告警。`,
    points: ["本地消息表与 TCC 的代价对比", "对账必须逐笔而非对总额", "差异分类与补单闭环"],
    follow: "如果对账发现的是历史遗留差异，你怎么判断该补单还是该冲正？",
    sources: [
      { repo: "advanced-java", path: "docs/distributed-system/" },
      { repo: "JavaGuide", path: "docs/distributed-system/" },
    ],
  },
  {
    id: "system-b-consistency-trace-id",
    category: "system",
    topic: "分布式与一致性",
    difficulty: 2,
    tags: ["链路追踪", "traceId", "排查"],
    question: "分布式链路 ID 怎么透传，它对线上排查到底值多少钱？",
    answer: `结论：网关生成 traceId，经 HTTP Header、MQ 消息属性和线程上下文透传，把散落在多个服务的日志串成一条线。

- 方案一 自研拦截器：Feign 和 RestTemplate 加拦截器往 Header 塞 traceId。代价是异步和线程池要手动传递，漏一处链路就断。
- 方案二 OpenTelemetry 自动埋点：HTTP、JDBC、Redis 都自动注入，标准统一还有 span 耗时。代价是要升级 SDK，全量采样存储成本很高。

最容易踩的坑是跨线程丢上下文，线程池复用会让 traceId 串号，提交任务时必须显式捕获再还原。MQ 消费要把 traceId 放进消息属性，否则异步链路直接断掉。

排查时按 traceId 还原调用树，先看耗时占比最高的 span，而不是从头读日志。监控 traceId 覆盖率、单链路 span 数和采样率，覆盖率低于百分之九十九就说明有链路没接进来。`,
    points: ["两种透传方案的代价对比", "线程池与 MQ 是断链重灾区", "按调用树定位而非逐条读日志"],
    follow: "采样率只有百分之一，恰好出问题的那次请求没被采样，你怎么查？",
    sources: [
      { repo: "JavaGuide", path: "docs/distributed-system/" },
      { repo: "tech-interview-handbook", path: "apps/portal/" },
    ],
  },
  {
    id: "system-b-consistency-multi-datacenter",
    category: "system",
    topic: "分布式与一致性",
    difficulty: 2,
    tags: ["多机房", "单元化", "数据同步"],
    question: "多机房部署怎么设计流量调度和数据同步，单元化到底解决了什么问题？",
    answer: `结论：单元化的核心是按用户 ID 哈希分片，让同一用户的数据和流量固定落在同一个单元，单元内闭环，跨单元只做异步同步。

- 方案一 binlog 单向同步：主机房写，备机房通过 binlog 追数据，延迟百毫秒级，架构简单。代价是备机房只能读，写切换要等数据追平，切换窗口是分钟级。
- 方案二 单元化加异步补偿：每个单元都能写自己那部分用户，单元间用消息异步同步。可用性最高，单机房挂了只影响那部分用户；代价是改造量巨大，要处理历史数据迁移和分片键重分布。

流量调度靠 DNS 和 GSLB 按用户归属路由，灰度切流时先切百分之一观察，确认数据追平再放量。切流前必须确认同步位点已追平，否则会丢数据，这是最容易出事故的一步。

坑在于单元内单点故障时不能简单把流量切到其他单元，因为那里没有这个用户的数据，只能降级或只读。监控单元内成功率、同步延迟和跨单元调用量，同步延迟超过 1 秒告警，跨单元调用占比超过百分之五说明分片键选错了。`,
    points: ["按用户分片让单元内闭环", "binlog 与单元化双写的代价", "切流前必须确认数据追平"],
    follow: "用户量增长后需要重新分片，怎么在不中断服务的前提下迁移数据？",
    sources: [
      { repo: "system-design-primer", path: "solutions/system_design/scaling_aws/" },
      { repo: "advanced-java", path: "docs/distributed-system/" },
    ],
  },
  {
    id: "system-b-storage-hot-cold-archive",
    category: "system",
    topic: "数据与存储",
    difficulty: 2,
    tags: ["冷热分离", "归档", "分区表"],
    question: "订单表已经两亿行，怎么做冷热数据分离和归档？",
    answer: `结论：按时间和访问频率划一条线，热数据留 3 个月在 MySQL，冷数据归档到对象存储或 ClickHouse。

- 方案一 表级归档：建 order_archive 表，按 create_time 分批搬老数据，成本低。代价是历史查询要同时查两张表，接口层要写路由逻辑，稍不注意就漏查。
- 方案二 分区表加冷存储：按时间分区，查询自动裁剪分区，运维省心。代价是删分区会锁表，分区数也不能无限加，超过 100 个元数据开销明显。
- 方案三 冷热分层到不同存储：冷数据进 ClickHouse 或对象存储加 Presto。容量几乎无限，查询成本低；代价是多一套存储和同步链路，冷查询延迟到秒级。

坑在于归档任务会抢 IO，必须限速并放在低峰期跑，否则白天归档会把线上拖慢。冷数据查询要用异步导出，不要同步查。删除只做软删，保留 7 天反悔窗口，归档前先做备份和抽样校验。监控热表增长速度，超过 5000 万行就触发归档。`,
    points: ["三种归档方案的代价对比", "归档限速避免抢线上 IO", "软删与可恢复性校验"],
    follow: "归档后业务突然要查两年前的数据，你的方案能多快响应？",
    sources: [
      { repo: "JavaGuide", path: "docs/database/mysql/" },
      { repo: "system-design-primer", path: "solutions/system_design/query_cache/" },
    ],
  },
  {
    id: "system-b-storage-cache-db-consistency",
    category: "system",
    topic: "数据与存储",
    difficulty: 2,
    tags: ["双写一致性", "延迟双删", "binlog"],
    question: "缓存和数据库双写一致性有哪几种方案，你线上会选哪个？",
    answer: `结论：选先更新库再删缓存加延迟双删，再用 binlog 订阅兜底，别指望靠调整更新顺序解决一致性问题。

- 先删缓存再更新库：读请求在删除后、更新前把旧值回填，脏数据长期驻留，并发越高越容易踩。只有写极少、能接受长时间脏读的场景才用。
- 先更新库再删缓存：只有删缓存失败那一个窗口会脏，概率低得多，代价是要处理删除失败，通常配合重试队列。
- 延迟双删：更新库后删一次，再等 500ms 到 1s 删第二次，覆盖旧值回填。代价是写多时这个延迟窗口被放大，删两次也增加缓存压力。
- binlog 订阅：业务代码完全不背这个锅，由中间件消费 binlog 异步删缓存。代价是引入中间件和秒级延迟，链路更长更难排查。

真正的兜底是 TTL 加补偿，缓存设 10 到 30 分钟并加百分之十抖动，删除失败进重试队列，重试 3 次仍失败就告警人工介入。监控删缓存失败率、主从延迟、缓存与库的抽样比对差异数。`,
    points: ["四种方案的脏窗口对比", "延迟双删的延迟怎么估", "TTL 与删除失败补偿"],
    follow: "延迟双删的第二次删除也失败了，脏数据要多久才能自愈？",
    sources: [
      { repo: "JavaGuide", path: "docs/database/redis/" },
      { repo: "advanced-java", path: "docs/high-concurrency/" },
    ],
  },
  {
    id: "system-b-storage-deep-pagination",
    category: "system",
    topic: "数据与存储",
    difficulty: 1,
    tags: ["深分页", "游标分页", "延迟关联"],
    question: "LIMIT 1000000, 10 这种深分页为什么慢，线上怎么优化？",
    answer: `结论：MySQL 要先扫描并丢弃前一百万行再取十行，代价是 O(offset)，优化方向是让数据库不再扫这些行。

- 游标分页：记住上一页最后一条的 ID，下一页用 WHERE id 大于上次最后 ID 加 ORDER BY id LIMIT 10。复杂度降到 O(1)，代价是不支持跳页，只能上下翻。
- 延迟关联：先在覆盖索引上取出主键再回表，深页提升能到十倍以上。代价是多一次 join，省掉的却是大量随机 IO。
- 业务侧限制：禁止翻到 100 页以后，或改成推荐流和筛选条件，因为用户几乎不会真的翻到那么深。

坑在于排序字段必须唯一，否则游标分页会漏数据或重复，所以要用 ORDER BY id 或加一个唯一列做第二排序键。ES 场景用 search_after 替代 from 加 size，后者超过 10000 会直接报错。监控慢查询里扫描行数与返回行数的比值，比值超过 100 就是深分页，同时统计深分页请求占比。`,
    points: ["O(offset) 的代价讲清楚", "游标分页与延迟关联的取舍", "排序字段必须唯一防漏数据"],
    follow: "如果产品坚持要支持跳到第 500 页，你怎么在不改接口语义的前提下优化？",
    sources: [
      { repo: "JavaGuide", path: "docs/database/mysql/" },
      { repo: "CS-Notes", path: "docs/" },
    ],
  },
  {
    id: "system-b-ops-gray-release",
    category: "system",
    topic: "运维与发布",
    difficulty: 2,
    tags: ["灰度发布", "回滚", "DDL"],
    question: "灰度发布怎么做，回滚时数据库变更不兼容怎么办？",
    answer: `结论：灰度按机器、用户、流量三个维度放量，数据库变更必须先做到向前兼容，再谈回滚。

- 机器维度：K8s 滚动更新加一批新实例，实现最简单。代价是粒度粗，用户可能在新老实例之间来回跳。
- 用户维度：按用户 ID 哈希分流，同一用户体验稳定，适合需要连续性的业务。代价是网关要维护分流规则，规则出错会影响一批用户。
- 流量维度：按百分比随机分流，放量平滑。代价是同一用户可能命中不同版本，出现刷新一下就好了这类诡异问题。

数据库变更走扩展、迁移、收缩三段：先加新字段并双写，再刷历史数据，最后切读并下线旧字段，每个阶段都能独立回滚，回滚代码时两种结构都兼容。

坑在于回滚镜像不会回滚数据库，所以每个 DDL 都要准备反向 SQL，且新代码必须兼容旧表结构。灰度期间做新老结果对比，是发现兼容问题最有效的手段。监控错误率、P99 延迟和核心业务指标，错误率超过百分之一或延迟翻倍立即回滚，目标 10 分钟内完成。`,
    points: ["三个灰度维度的粒度取舍", "扩展迁移收缩三段式", "回滚前先准备反向 SQL"],
    follow: "灰度期间新老版本结果不一致，你怎么判断是哪个版本的 bug？",
    sources: [
      { repo: "JavaGuide", path: "docs/database/mysql/" },
      { repo: "tech-interview-handbook", path: "apps/portal/" },
    ],
  },
  {
    id: "system-b-ops-incident-response",
    category: "system",
    topic: "运维与发布",
    difficulty: 2,
    tags: ["故障应急", "复盘", "止血"],
    question: "线上出故障了，你的应急流程是什么，复盘要复盘出什么？",
    answer: `结论：按止血、定位、复盘三步走，先恢复再找根因，不要一上来就查代码。

- 止血优先：第一时间判断影响面，多少用户、哪些接口、有没有资损，能用限流、降级、回滚这类快手段止血就先止血。回滚永远比修 bug 快。
- 定位顺序：先看最近变更（发布、配置、DDL），再查依赖（DB、Redis、下游服务），最后看容量（QPS、连接数、线程池）。指标、日志、链路三者缺一不可，只看日志很容易被误导。
- 复盘要点：写清楚时间线、根因、改进项和责任人，重点放在可改动的流程和监控上，而不是追责。没有改进项和截止时间的复盘等于没开。

坑在于止血手段本身会造成二次故障，粗暴回滚可能带来流量尖峰，直接摘流量可能触发客户端重试风暴。所以止血前要评估副作用，必要时先扩容再回滚。

监控错误率、延迟和核心业务指标，错误率超过百分之一或延迟翻倍触发告警。应急期间每 5 分钟同步一次进展，指定唯一指挥人，避免多人同时操作。`,
    points: ["先止血再定位，回滚最快", "按变更依赖容量的顺序排查", "复盘必须有改进项和责任人"],
    follow: "故障根因是一个半年前埋下的设计缺陷，你的复盘会怎么写？",
    sources: [
      { repo: "tech-interview-handbook", path: "apps/portal/" },
      { repo: "system-design-primer", path: "solutions/system_design/" },
    ],
  },
  {
    id: "system-b-security-api-authorization",
    category: "system",
    topic: "安全与权限",
    difficulty: 3,
    tags: ["越权", "签名", "重放攻击"],
    question: "接口鉴权怎么设计，水平越权和垂直越权分别怎么防？",
    answer: `结论：鉴权分认证、鉴权、防重放三层，越权事故绝大多数不是逻辑写错，而是漏了资源归属校验。

- 认证与鉴权：认证解决你是谁，鉴权解决你能做什么，必须每次从服务端查权限，不能信任前端传来的角色或用户 ID。
- 水平越权：A 用户能访问 B 用户的订单，根因是只校验了登录态没校验归属。防法是数据访问层强制拼上当前用户 ID 条件，把归属校验下沉到 DAO，别指望每个接口都记得写。
- 垂直越权：普通用户能调管理员接口，要按角色加资源维度做校验，网关做粗粒度拦截，业务层做细粒度校验。
- 防重放：把参数、时间戳、随机数一起做 HMAC 签名，时间戳偏差超过 5 分钟直接拒绝，随机数存 Redis 设 5 分钟过期，重复出现即判定重放。

坑在于越权往往是忘了加校验而不是校验写错了，所以要在网关强制注入用户身份并对每个接口做归属校验，同时防住 ID 遍历。监控越权拦截数和签名失败率，后者超过百分之一可能正在被探测。`,
    points: ["归属校验下沉到数据访问层", "垂直越权要网关加业务双层", "时间戳加随机数防重放"],
    follow: "内部服务之间的调用也要做签名吗，怎么避免把密钥散落到每个服务？",
    sources: [
      { repo: "JavaGuide", path: "docs/system-design/security/" },
      { repo: "tech-interview-handbook", path: "apps/portal/" },
    ],
  },
];
