// 面试题库 · 系统设计 / 场景题。
// 本文件是「面试刷题」工具的离线数据源之一，只负责系统设计类问答：按 topic 分组、
// difficulty 分级，question 是面试官口吻的提问，answer 是可直接背诵的参考答案，
// points 是自评清单（三条都答到才算过关），follow 是面试官常见的下一句追问。
// 来源引用约定：sources 用「仓库名 + 仓库内相对路径」表示延伸阅读位置，不写完整 URL，
// 便于离线检索与来源追溯；repo 只取 system-design-primer、advanced-java、JavaGuide、
// CS-Notes、tech-interview-handbook 五个开源仓库，path 必须是该仓库中真实存在的路径前缀。
export const SYSTEM_QUESTIONS = [
  {
    id: "system-cache-consistency",
    category: "system",
    topic: "缓存",
    difficulty: 2,
    tags: ["缓存", "一致性", "延迟双删"],
    question: "缓存和数据库的一致性怎么保证，先更新库还是先删缓存？",
    answer: `先更新数据库再删缓存，这是默认答案；但真正兜住一致性的不是顺序，而是补偿和过期时间。

- 先删缓存再更新库：读请求在删除后、更新前把旧值回填，脏数据长期驻留，并发越高越容易踩。只有写少读多且能接受短时脏读才用。
- 先更新库再删缓存：只有删缓存失败的那个窗口会脏，概率低得多，代价是要处理删除失败。
- 延迟双删：更新库后删一次，再等 500ms 到 1s 删第二次，覆盖旧值回填。延迟按主从同步耗时估，写多时会放大。
- 更稳的是订阅 binlog（Canal）异步删缓存，业务代码不背这个锅，代价是引入中间件和秒级延迟。

兜底一定是 TTL，缓存设 10 到 30 分钟并加随机抖动，避免集中失效。监控删缓存失败率、主从延迟、缓存与库的抽样比对差异数；删缓存失败进重试队列，重试 3 次仍失败就告警人工介入。`,
    points: ["先更新库再删缓存，并说明原因", "延迟双删或 binlog 订阅的补偿", "TTL 兜底与删除失败监控"],
    follow: "如果删缓存一直失败，你怎么保证最终一致？",
    sources: [
      { repo: "advanced-java", path: "docs/high-concurrency/" },
      { repo: "JavaGuide", path: "docs/database/redis/" },
    ],
  },
  {
    id: "system-cache-penetration-breakdown",
    category: "system",
    topic: "缓存",
    difficulty: 1,
    tags: ["缓存穿透", "缓存击穿", "缓存雪崩"],
    question: "缓存穿透、击穿、雪崩分别是什么，怎么防？",
    answer: `三个问题根因不同，方案不能混用，混着答是典型的减分点。

- 穿透：查根本不存在的数据，请求全打到库。一是布隆过滤器，内存占用小但有误判，适合 id 集合稳定的场景；二是缓存空值，TTL 设 1 到 5 分钟，代价是可能堆积大量垃圾 key，要限制空值 key 的总量。两者叠加最常用。
- 击穿：单个热点 key 过期瞬间并发全打到库。一是逻辑过期，value 里带过期时间，异步重建，读到的旧值仍可用；二是互斥重建，只有一个线程加载，其余等待，代价是等待线程要设 200ms 超时，超时返回降级值。
- 雪崩：大批 key 同时失效或缓存集群挂掉。TTL 加随机抖动，上下浮动 10%；缓存做主从加多副本；服务侧加熔断和本地缓存兜底。

监控命中率、空值 key 占比、缓存重建耗时、数据库 QPS 突刺。命中率跌破 80% 或重建线程排队超过 100 就告警。`,
    points: ["三者根因区分清楚", "每类给出可落地的方案", "TTL 抖动与监控指标"],
    follow: "布隆过滤器误判放过的请求怎么处理？",
    sources: [
      { repo: "JavaGuide", path: "docs/database/redis/" },
      { repo: "advanced-java", path: "docs/high-concurrency/" },
    ],
  },
  {
    id: "system-cache-hotkey-governance",
    category: "system",
    topic: "缓存",
    difficulty: 2,
    tags: ["热点key", "本地缓存", "key打散"],
    question: "单个热点 key 把一台 Redis 打满了，怎么发现和治理？",
    answer: `先确认是不是热点：用 redis-cli --hotkeys、monitor 采样或客户端埋点统计 topN，看 QPS 是不是集中在少数 key 上。Redis 单分片十万 QPS 就到顶，热点 key 会让整个集群的容量白买。

- 读热点：本地缓存加一层，Caffeine 存 1 到 5 秒，热点数据几乎不回源。代价是多实例间有几秒不一致，适合商品详情、配置这类能忍延迟的数据。再不行把 key 打散成 key:0 到 key:9 十个副本，读时随机取，代价是更新要写十份。
- 写热点：计数类场景（库存、点赞）先在本地或 Redis 聚合，按 100ms 或 1000 次批量落库。代价是进程崩溃会丢最后一批，可以加 WAL 补。
- 极端情况上多级缓存加请求合并，同一 key 的并发请求只放一个到后端。

监控单分片 QPS、大 key 与热 key 排名、本地缓存命中率。热点探测要常态化跑，别等打满了才发现。`,
    points: ["先说清怎么发现热点 key", "读热点与写热点分开治理", "本地缓存或打散的代价"],
    follow: "本地缓存导致多实例不一致，业务上不能接受怎么办？",
    sources: [
      { repo: "JavaGuide", path: "docs/database/redis/" },
      { repo: "advanced-java", path: "docs/high-concurrency/" },
    ],
  },
  {
    id: "system-cache-multilevel-consistency",
    category: "system",
    topic: "缓存",
    difficulty: 3,
    tags: ["多级缓存", "本地缓存", "最终一致"],
    question: "多级缓存怎么保证数据不脏，到底值不值得做？",
    answer: `多级缓存换来的是延迟和吞吐：本地命中是百纳秒级，Redis 是毫秒级，还能扛住 Redis 整体挂掉。代价是多实例之间的不一致窗口，必须先承认它只是最终一致。

- 短 TTL 方案：本地只存 1 到 3 秒，过期自动纠正。实现最简单，不一致窗口就是 TTL 长度，适合商品标题、榜单这类能忍几秒的数据。
- 广播失效方案：更新后发 MQ 或 Redis pub/sub，各实例收到就删本地 key，窗口压到百毫秒级。代价是消息丢失或实例重启期间会读到旧值，仍要靠 TTL 兜底。
- 只放准静态数据：类目、配置、字典这类几乎不变的放本地，变更走发布系统主动推。这是最稳的用法。

判断值不值得：QPS 上万、Redis 带宽或单分片已成瓶颈、业务能接受秒级不一致，才上多级。监控本地与 Redis 的抽样差异、失效消息到达率、本地命中率。库存、余额这类强一致数据绝不能进本地缓存。`,
    points: ["承认本地缓存只是最终一致", "广播失效与短 TTL 的代价对比", "说清什么数据不能进本地缓存"],
    follow: "失效广播丢消息怎么发现和补救？",
    sources: [
      { repo: "JavaGuide", path: "docs/database/redis/" },
      { repo: "advanced-java", path: "docs/high-concurrency/" },
    ],
  },
  {
    id: "system-concurrency-peak-shaving",
    category: "system",
    topic: "高并发",
    difficulty: 2,
    tags: ["削峰", "异步化", "消息队列"],
    question: "大促流量是平时的十倍，怎么削峰和异步化？",
    answer: `核心是把同步链路变短，把非关键路径挪走，再用队列把瞬时洪峰摊平。同步链路只留下单、扣库存、支付，其余全部异步。

- 同步转异步：发券、积分、短信、推送、写日志都丢进 MQ，接口 RT 从 200ms 降到 50ms 以内。代价是用户看不到即时结果，要靠轮询或推送补偿，业务得接受最终一致。
- 队列削峰：入口按下游能承受的速率限流，下游 2000 QPS 就限 2000，多出来的排队或快速失败。积压水位按消费速率的 5 分钟量设阈值。
- 请求合并：同一秒内相同商品的查询合并成一次回源，批量写按 100 条或 200ms 触发。

坑在于异步之后错误没人管：MQ 必须配死信队列，重试 3 次仍失败就进死信并告警；异步链路的成功率要单独监控，否则用户投诉了才发现券没发。盯入口 QPS、队列堆积量、消费延迟 P99、异步任务成功率。`,
    points: ["同步链路只保留核心写操作", "削峰与限流水位怎么定", "异步失败的死信与监控"],
    follow: "队列积压到几百万条，怎么快速消费掉？",
    sources: [
      { repo: "advanced-java", path: "docs/high-concurrency/" },
      { repo: "JavaGuide", path: "docs/system-design/basis/" },
    ],
  },
  {
    id: "system-concurrency-read-write-split-lag",
    category: "system",
    topic: "高并发",
    difficulty: 1,
    tags: ["读写分离", "主从延迟", "半同步复制"],
    question: "读写分离怎么做，主从延迟导致刚写完读不到怎么办？",
    answer: `读写分离解决的是读多写少的容量问题，通常读 QPS 是写的 5 到 10 倍。做法是写主库、读从库，用中间件（ShardingSphere、ProxySQL）或代码注解路由。

- 强一致读走主库：下单后跳订单详情、支付后查状态这类写后立即读的请求强制路由主库。代价是主库压力上来了，所以要把范围压到最小。
- 会话粘性：同一用户写后 N 秒内的读都走主库，N 取主从延迟的 P99，一般 1 到 3 秒。实现简单，代价是主库流量按写比例放大。
- 半同步复制：至少一个从库确认才返回成功，窗口压到毫秒级，代价是写入 RT 上升 1 到 2ms，从库故障时会退化成异步。

真正的坑是延迟抖动：大事务、DDL、批量导入会把延迟从 10ms 拉到几十秒。监控 Seconds_Behind_Master 和 GTID 差值，超过 3 秒告警，同时给从库读加降级开关，超标自动切主库。`,
    points: ["写后读走主库或会话粘性", "半同步复制的性能代价", "延迟监控与自动降级"],
    follow: "大事务导致主从延迟飙升，除了告警还能做什么？",
    sources: [
      { repo: "JavaGuide", path: "docs/database/mysql/" },
      { repo: "advanced-java", path: "docs/high-concurrency/" },
    ],
  },
  {
    id: "system-concurrency-backpressure-pool",
    category: "system",
    topic: "高并发",
    difficulty: 3,
    tags: ["反压", "连接池", "线程池隔离"],
    question: "下游变慢导致上游线程池被占满，怎么做反压和连接池治理？",
    answer: `线程池被占满的本质是上游生产速率超过下游消费速率，且没有背压信号。治标是隔离和限流，治本是让压力往回传。

- 连接池参数：最大连接数不是越大越好，按下游能承受的并发倒推。下游单实例 200 并发、共 4 个实例，池子总上限 800 再留 20% 余量。HikariCP 的 maximumPoolSize 设 20 到 50，connectionTimeout 1 到 3 秒，超时快速失败而不是无限排队。
- 线程池隔离：每个下游一个独立线程池，核心 20、最大 50、队列 200，队列满直接拒绝。一个下游挂了不会拖垮整个服务，代价是线程数变多、上下文切换开销上升，要限制总线程数。
- 反压信号：队列使用率超过 80% 就拒绝新请求并返回 503 带 Retry-After，让上游自己退避。gRPC 和 Reactor 有原生背压，HTTP 只能靠状态码和队列水位约定。

监控活跃连接数、等待获取连接的线程数、拒绝数、下游 RT P99。活跃连接长期贴着上限说明下游已饱和，加机器之前先查慢查询。`,
    points: ["连接池大小按下游容量倒推", "线程池隔离防连锁故障", "队列水位作为反压信号"],
    follow: "队列满了直接拒绝体验很差，有更平滑的做法吗？",
    sources: [
      { repo: "JavaGuide", path: "docs/java/concurrent/" },
      { repo: "advanced-java", path: "docs/high-concurrency/" },
    ],
  },
  {
    id: "system-sharding-shard-key",
    category: "system",
    topic: "存储与分库分表",
    difficulty: 2,
    tags: ["分片键", "分库分表", "数据倾斜"],
    question: "分库分表的分片键怎么选，选错了会怎样？",
    answer: `第一原则是让八成以上的查询都能带上分片键，否则就是全路由，分片等于白做。

- 用户维度：按 user_id 取模或 hash，订单、消息、账单这类以用户为入口的场景最合适。代价是按商家、按时间的运营查询要扫所有分片，得靠异构索引表或 ES 兜。
- 时间维度：按月分表，冷热分离天然、归档方便。代价是写永远落在最新一张表，热点集中，查最近 7 天也只命中一张。
- 组合分片：先按 user_id 分 64 库，库内再按时间分表，兼顾单用户查询与历史归档。代价是路由逻辑复杂，扩容要同时动两级。

选错的典型症状是数据倾斜：某个大客户或爆款商品的订单占了 30% 的数据量。预防手段是先做数据分布分析再定分片数，分片数取 2 的幂（64、128）便于后续翻倍扩容。监控各分片的行数、QPS、慢查询，偏差超过 20% 就要查倾斜。`,
    points: ["分片键要覆盖主要查询路径", "至少两种分片维度及代价", "倾斜检测与分片数取法"],
    follow: "已经上线了才发现分片键选错，怎么迁？",
    sources: [
      { repo: "advanced-java", path: "docs/high-concurrency/database-shard-method.md" },
      { repo: "JavaGuide", path: "docs/system-design/basis/" },
    ],
  },
  {
    id: "system-sharding-scale-out",
    category: "system",
    topic: "存储与分库分表",
    difficulty: 3,
    tags: ["扩容", "双写", "数据迁移"],
    question: "分库分表后容量不够了，怎么做到不停机扩容？",
    answer: `扩容难在存量数据搬迁和增量同步，目标是全程可读可写、随时可回滚。

- 双写方案：新老分片同时写，读先用老分片兜底，后台按主键区间搬历史数据，搬完校验一致再切读、停老写。代价是双写期间要处理部分失败，必须新老写都成功才算成功，否则数据会缺。
- 停写迁移：低峰期停写 5 到 10 分钟，导出导入后切换。实现最简单，代价是有停机窗口，只适合内部系统。
- 平滑方案（推荐）：先做从库级联同步把存量追平，再用 binlog 订阅补增量，延迟降到 1 秒内后按 1%、10%、50%、100% 灰度切读，观察错误率和 RT 再全量。

分片数一定要留倍数，64 扩到 128 时每个老分片只裂成两个，搬迁量可控；一开始定 100 片再扩到 200 片，路由规则改动面大得多。监控迁移进度、双写失败率、新老数据比对差异行数，差异不为 0 就不许切读，回滚开关要提前演练。`,
    points: ["双写加 binlog 增量同步的组合", "灰度切读的百分比节奏", "分片数留倍数便于翻倍"],
    follow: "双写期间新分片写失败，你怎么保证不丢数据？",
    sources: [
      { repo: "advanced-java", path: "docs/high-concurrency/database-shard-dynamic-expand.md" },
      { repo: "JavaGuide", path: "docs/system-design/basis/" },
    ],
  },
  {
    id: "system-sharding-global-id-generate",
    category: "system",
    topic: "存储与分库分表",
    difficulty: 2,
    tags: ["全局ID", "雪花算法", "号段"],
    question: "分库分表后主键 ID 怎么生成，为什么不用 UUID？",
    answer: `UUID 是 128 位且无序，InnoDB 聚簇索引会频繁页分裂，插入性能掉一半以上，所以基本不用。

- 数据库号段：一张表存业务名和当前最大值，每次取 1000 个号段到内存分发，QPS 上万没问题。代价是应用重启会浪费一段号，数据库是单点，要配主从和双 buffer 预加载。
- 雪花算法：64 位，1 位符号、41 位毫秒时间、10 位机器、12 位序列，单机每毫秒 4096 个。趋势递增、性能最好，代价是强依赖时钟，回拨会重复发号，必须检测回拨并等待或直接拒绝服务。
- Redis INCR：实现简单，但每次发号一次网络往返，QPS 高时 Redis 成瓶颈，持久化配置不当还会重号。

生产上常用雪花加号段兜底：正常走本地雪花，检测到时钟回拨超过 5ms 就切号段模式。监控发号耗时 P99、时钟回拨次数、号段剩余量（低于 20% 提前加载）。ID 里不要塞业务含义，后期改不动。`,
    points: ["UUID 无序带来的索引代价", "号段与雪花的取舍", "时钟回拨处理与监控"],
    follow: "雪花算法的机器号在容器环境里怎么分配？",
    sources: [
      { repo: "advanced-java", path: "docs/high-concurrency/database-shard-global-id-generate.md" },
      { repo: "JavaGuide", path: "docs/distributed-system/distributed-id.md" },
    ],
  },
  {
    id: "system-mq-idempotent-consume",
    category: "system",
    topic: "消息队列",
    difficulty: 2,
    tags: ["幂等", "重复消费", "去重表"],
    question: "消息重复消费怎么保证幂等？",
    answer: `MQ 只保证至少一次投递，重复不可避免：生产者重试、ack 丢失、rebalance 都会重发。所以幂等必须做在消费端，指望 MQ 不重发是不现实的。

- 唯一键去重表：用业务唯一键（订单号加操作类型）建唯一索引，插入成功才处理，重复插入直接返回。简单可靠，代价是每次消费多一次写库，高并发下这张表是热点，要按时间分表并定期清理 7 天前的记录。
- 状态机判断：订单状态只能从待支付到已支付，更新时带上原状态条件，影响行数为 0 说明已经处理过。零额外存储，代价是只适用于有明确状态流转的业务。
- Redis 去重：setnx 一个带 TTL 的 key，1 到 24 小时过期。性能好，代价是 Redis 丢数据会漏判，只能当前置过滤，最终仍要靠数据库唯一约束兜底。

关键是消费逻辑里所有副作用都要可重入：发短信、加积分、扣库存都得带业务流水号。监控重复消息比例、去重命中数、消费重试次数，重复率突然升高通常是 rebalance 频繁。`,
    points: ["去重表加唯一索引是兜底", "状态机或 Redis 前置过滤的取舍", "副作用都要可重入"],
    follow: "去重表本身成了写入瓶颈，怎么优化？",
    sources: [
      { repo: "advanced-java", path: "docs/distributed-system/distributed-system-idempotency.md" },
      { repo: "JavaGuide", path: "docs/system-design/basis/" },
    ],
  },
  {
    id: "system-mq-ordering-guarantee",
    category: "system",
    topic: "消息队列",
    difficulty: 2,
    tags: ["顺序消息", "分区", "局部有序"],
    question: "怎么保证消息的顺序性？",
    answer: `全局有序代价极高，先确认业务是不是只需要局部有序。绝大多数场景只要同一个订单、同一个用户的消息有序。

- 单队列单消费者：全局有序的唯一办法，吞吐被压到单线程，一般每秒几千条。只有账单流水这类场景才值得。
- 按业务键分区：用 orderId 做分区键，同一订单进同一队列，队列内单线程消费。Kafka 按 key hash 到 partition，RocketMQ 用 MessageQueueSelector。代价是热点订单会让某个队列倾斜，要监控各队列的堆积差。
- 消费端串行化：多消费者并发拉取，但按业务键 hash 到内存队列，每个内存队列一个线程处理。吞吐和顺序兼得，代价是内存队列积压占堆内存，要限长并落盘兜底。

最常见的坑是重试破坏顺序：一条消息失败重试会插到后面消息之后。做法是失败就阻塞该队列并告警，或把失败消息丢到重试 topic 延迟重投，绝不能让后续消息先过。监控单队列消费延迟和乱序检测数。`,
    points: ["先确认只需要局部有序", "按业务键分区加队列内串行", "重试不能破坏顺序"],
    follow: "某条消息一直失败，阻塞队列会造成积压，怎么办？",
    sources: [
      { repo: "advanced-java", path: "docs/distributed-system/distributed-system-request-sequence.md" },
      { repo: "JavaGuide", path: "docs/system-design/basis/" },
    ],
  },
  {
    id: "system-mq-backlog-handle",
    category: "system",
    topic: "消息队列",
    difficulty: 1,
    tags: ["消息积压", "扩容", "死信"],
    question: "线上消息积压了几百万条，怎么处理？",
    answer: `先判断是消费变慢还是生产暴涨，两条路处理方式完全不同。看消费 TPS 曲线和生产 TPS 曲线，一眼能分出来。

- 消费变慢：查消费者日志有没有大量报错、下游 RT 是不是涨了、有没有线程被阻塞，常见原因是慢查询或第三方接口超时。修掉之后扩消费者实例，注意消费者数不能超过分区数，超过就是白扩，得先扩分区。
- 生产暴涨：多半是上游重试风暴或定时任务撞车。先在上游限流或临时降级非核心消息，把流量压回正常水位，再谈消费。
- 紧急恢复：积压已经影响业务时，临时写一个只做转发的消费者，把消息原样搬到临时 topic，用几十个消费者并行消费。代价是顺序性丢失，只用于可乱序的业务。

恢复后必须补三件事：确认没有消息因 retention 过期被删，核对总量，丢失的走对账补发。监控堆积量、消费延迟、死信数量，堆积超过 5 分钟的消费量就告警。`,
    points: ["先区分消费慢还是生产暴涨", "消费者数受分区数限制", "恢复后核对是否丢消息"],
    follow: "在线扩分区有什么风险，能不能做？",
    sources: [
      { repo: "advanced-java", path: "docs/high-concurrency/" },
      { repo: "JavaGuide", path: "docs/system-design/basis/" },
    ],
  },
  {
    id: "system-consistency-cap-tradeoff",
    category: "system",
    topic: "一致性",
    difficulty: 1,
    tags: ["CAP", "BASE", "取舍"],
    question: "CAP 怎么理解，实际系统里怎么选？",
    answer: `CAP 说的是网络分区发生时，一致性 C 和可用性 A 只能保一个。P 在分布式系统里是既定事实，不是可选项，所以真正要回答的是分区期间保 C 还是保 A。

- 保 CP：分区时拒绝写入或返回错误，保证不会读到不一致数据。ZooKeeper、etcd、银行核心账务属于这类。代价是少数派节点不可用，用户直接看到报错。
- 保 AP：分区时各节点继续读写，事后合并冲突。注册、浏览、购物车、点赞属于这类。代价是要处理冲突，通常靠最后写入优先或版本向量。

实际系统很少纯 CP 或纯 AP，而是按数据分级：钱和库存走 CP 加对账兜底，商品信息和评价走 AP 加最终一致。BASE 就是 AP 的工程化说法：基本可用、软状态、最终一致。监控要盯分区恢复后的收敛时间，以及不一致记录条数，收敛时间超过 SLA 就得人工介入。`,
    points: ["P 是前提，只在 C 和 A 之间选", "给出 CP 和 AP 的具体业务例子", "按数据分级而非一刀切"],
    follow: "最终一致的数据怎么让用户感知不到问题？",
    sources: [
      { repo: "advanced-java", path: "docs/distributed-system/distributed-system-cap.md" },
      { repo: "system-design-primer", path: "solutions/system_design/" },
    ],
  },
  {
    id: "system-consistency-distributed-transaction",
    category: "system",
    topic: "一致性",
    difficulty: 3,
    tags: ["分布式事务", "TCC", "本地消息表"],
    question: "跨服务的分布式事务你线上会选哪个方案，为什么？",
    answer: `先看能不能不做分布式事务：把跨服务调用收敛成单库本地事务，或用状态机加补偿，比任何框架都可靠。

- TCC：Try 预留、Confirm 确认、Cancel 释放，业务侵入大，每个接口写三份。适合资金、库存这类需要强预留的场景。代价是空回滚、悬挂、幂等都得自己处理，Cancel 必须能应对 Try 没执行的情况。
- 本地消息表加 MQ：本地事务里同时写业务数据和消息表，再异步投递，下游幂等消费。最终一致、实现简单，代价是多一张消息表和轮询，延迟在百毫秒到秒级。多数业务的最优选。
- Seata AT：靠 undo log 自动回滚，接入成本低，代价是全局锁放大冲突，高并发下 RT 上升明显，只适合并发不高的后台系统。
- 真强一致只能上 2PC 类协议，性能和可用性都差，除金融核心外基本不用。

不管选哪个都要有对账：每天跑一次差异比对，把不一致的单据捞出来自动或人工修复。监控事务成功率、悬挂与空回滚次数、对账差异条数。`,
    points: ["先问能不能避免分布式事务", "本地消息表与 TCC 的取舍", "对账是最后一道防线"],
    follow: "TCC 的空回滚和悬挂具体怎么防？",
    sources: [
      { repo: "advanced-java", path: "docs/distributed-system/distributed-transaction.md" },
      { repo: "JavaGuide", path: "docs/distributed-system/distributed-transaction.md" },
    ],
  },
  {
    id: "system-availability-circuit-breaker-degrade",
    category: "system",
    topic: "可用性",
    difficulty: 2,
    tags: ["熔断", "降级", "隔离"],
    question: "熔断和降级怎么设计，阈值怎么定？",
    answer: `熔断是自动的，降级是提前备好的兜底逻辑，两者必须配对。只熔断不降级，等于把错误直接抛给用户。

- 熔断阈值：滑动窗口 10 秒，请求数超过 20 才开始统计（样本太少不熔断），错误率超过 50% 或慢调用比例超过 30% 就打开，打开后 5 到 10 秒放一个探测请求，成功则半开恢复。Sentinel、Resilience4j 都是这个模型。错误率阈值别设太低，设 20% 会把偶发抖动也熔断。
- 降级策略：返回缓存或默认值（推荐列表为空、库存显示充足）、返回兜底静态数据、或快速失败。降级开关要能一键切换，配置放配置中心，别改代码发版。
- 隔离：按下游拆线程池或信号量，一个下游熔断不牵连其他。

坑在于降级逻辑本身从没测过，真出事才发现兜底数据是错的。降级开关要定期演练，每季度手动打开一次看效果。监控熔断打开次数、降级触发次数、半开恢复成功率，熔断频繁说明下游容量不足，别只会调阈值。`,
    points: ["熔断的窗口、错误率与半开参数", "降级要有兜底数据且可一键开关", "降级逻辑必须演练"],
    follow: "熔断打开后下游恢复了，流量怎么自动放回去？",
    sources: [
      { repo: "advanced-java", path: "docs/high-concurrency/" },
      { repo: "JavaGuide", path: "docs/system-design/framework/" },
    ],
  },
  {
    id: "system-availability-timeout-retry-storm",
    category: "system",
    topic: "可用性",
    difficulty: 2,
    tags: ["超时", "重试", "重试风暴"],
    question: "超时和重试怎么设，怎么避免重试把下游打死？",
    answer: `超时必须是链路预算的概念，不是每个服务各拍一个数。用户能忍 1 秒，网关就 1 秒，服务 A 拿 800ms，调 B 给 500ms，B 调 C 给 200ms，逐层递减。

- 超时设置：取下游 RT 的 P99 再乘 1.5，通常 200 到 500ms。设太短会误杀正常慢请求，设太长会拖垮线程池。连接超时单独设，100 到 300ms 就够。
- 重试策略：只重试幂等的读请求和明确可重试的错误（连接失败、503、超时），业务失败不重试。次数 2 到 3 次，间隔用指数退避加抖动，比如 100ms、300ms、900ms 各加 20% 随机。同步链路最多重试一次，其余靠异步补偿。
- 防雪崩：下游已经大面积超时时，重试只会放大流量，要在客户端加熔断，熔断打开期间直接不重试。重试总流量要封顶，比如不超过原始 QPS 的 20%。

监控重试率、重试成功率、超时率、下游 RT 分位。重试率超过 10% 说明下游有问题，重试成功率低于 30% 说明重试没意义，应该直接失败。`,
    points: ["超时按链路预算逐层递减", "只重试幂等请求且退避加抖动", "重试总流量要封顶"],
    follow: "异步补偿的重试怎么做才不会重复扣款？",
    sources: [
      { repo: "JavaGuide", path: "docs/system-design/basis/" },
      { repo: "advanced-java", path: "docs/high-concurrency/" },
    ],
  },
  {
    id: "system-ratelimit-algorithm-choice",
    category: "system",
    topic: "限流与降级",
    difficulty: 1,
    tags: ["限流算法", "令牌桶", "漏桶"],
    question: "限流算法怎么选，单机限流和分布式限流差在哪？",
    answer: `四种算法解决不同问题，选错要么误杀要么放过。

- 固定窗口计数器：实现最简单，代价是窗口边界能被打进两倍流量。限制 100 QPS，在 0.9 秒和 1.1 秒各打 100 个请求就过了 200。只适合粗粒度保护。
- 滑动窗口：把窗口切成 10 个小格滚动统计，边界问题基本解决，代价是要存更多计数，内存与精度要权衡。
- 漏桶：恒定速率流出，能严格整形，代价是突发流量被排队或丢弃，适合保护下游数据库。
- 令牌桶：按速率放令牌，桶里攒下的令牌允许突发，最贴近真实业务，Guava RateLimiter 和 Sentinel 都是它。桶容量设成速率的 1 到 2 倍秒数。

单机限流简单，但集群总量等于单机乘实例数，一扩容就失效。分布式限流用 Redis 加 Lua 保证原子性，代价是每次请求一次网络往返，QPS 高时 Redis 成瓶颈，通常用本地令牌桶加 Redis 定期同步配额的混合方案。`,
    points: ["固定窗口的边界问题讲清楚", "令牌桶允许突发、漏桶整形", "分布式限流用 Redis 加 Lua 及其代价"],
    follow: "Redis 挂了限流怎么退化，放开还是全拒？",
    sources: [
      { repo: "JavaGuide", path: "docs/system-design/basis/" },
      { repo: "advanced-java", path: "docs/high-concurrency/" },
    ],
  },
  {
    id: "system-ratelimit-threshold-decision",
    category: "system",
    topic: "限流与降级",
    difficulty: 2,
    tags: ["限流阈值", "429", "分级限流"],
    question: "限流阈值怎么定，被限流的请求应该返回什么？",
    answer: `阈值不能拍脑袋，要压测出来再打折：单实例压到 RT 明显上升（P99 超过 200ms）或错误率超过 1%，那个 QPS 就是容量上限，线上阈值取它的 70% 到 80% 留余量。

- 分级限流：网关按用户维度（单用户 10 QPS）、接口维度（下单 500 QPS）、全局维度三层，哪层先到算哪层。VIP 单独配额，不和普通用户抢。
- 阈值来源：核心接口按容量倒推，非核心接口按历史峰值乘 1.5。大促前按预估流量提前调，别等出事再改。
- 返回语义：被限流返回 429 加 Retry-After 头，同时给业务错误码和友好文案，让前端能区分限流和故障。绝对不能返回 500，那会触发上游重试，越限越死。排队模式只在异步任务里用，同步接口排队会把连接占满。

监控限流触发次数、被限流的用户数、限流后的重试量。触发量突然上升，要么阈值太低，要么有人在刷，看请求分布区分。限流规则要能热更新，改阈值不该发版。`,
    points: ["阈值来自压测容量乘 0.7 到 0.8", "网关加用户加接口分级限流", "返回 429 而不是 500"],
    follow: "恶意刷接口的用户怎么识别和处置？",
    sources: [
      { repo: "JavaGuide", path: "docs/system-design/basis/" },
      { repo: "tech-interview-handbook", path: "apps/portal/" },
    ],
  },
  {
    id: "system-capacity-stress-test-method",
    category: "system",
    topic: "容量规划",
    difficulty: 2,
    tags: ["压测", "容量水位", "全链路压测"],
    question: "容量规划怎么做，压测要压出什么结论？",
    answer: `压测的目的不是拿一个 QPS 数字，而是找到系统拐点和瓶颈点，并验证扩容是否线性。

- 压测方法：单接口压测定基线，全链路压测定瓶颈。用生产同构环境，数据量也要同量级，否则索引和缓存表现完全不同。梯度加压，每档跑 5 到 10 分钟，记录 QPS、RT P99、错误率、CPU、GC、数据库连接数。
- 找拐点：QPS 上不去而 RT 开始翘尾的那个点就是容量上限。通常先到瓶颈的是数据库连接池、Redis 单分片或某个下游接口，报告里必须写清瓶颈在哪一层。
- 水位线：日常 CPU 不超过 40%，大促前不超过 60%，留 30% 以上余量应对突发和单机房故障。线程池、连接池使用率同理，超过 70% 就该扩容。
- 扩容验证：加一倍实例 QPS 是不是接近翻倍，不是就说明存在共享瓶颈，加机器没用。

坑是压测流量打到真实下游或污染生产数据，全链路压测要做流量标识别和影子表。另外别漏了压测期间的慢查询和 GC 次数。`,
    points: ["梯度加压找 RT 拐点", "水位线日常 40% 大促 60%", "验证扩容是否线性"],
    follow: "压测环境的数据量和线上差很多，结论还准吗？",
    sources: [
      { repo: "JavaGuide", path: "docs/system-design/basis/" },
      { repo: "system-design-primer", path: "solutions/system_design/scaling_aws/" },
    ],
  },
  {
    id: "system-capacity-estimate-back-of-envelope",
    category: "system",
    topic: "容量规划",
    difficulty: 1,
    tags: ["容量估算", "QPS", "存储估算"],
    question: "给你日活一百万，怎么估算存储和机器数量？",
    answer: `估算先定假设，再算量级，误差控制在 2 到 3 倍以内就够做架构决策。

- QPS：日活 100 万，假设人均 20 次请求，一天 2000 万次，平均约 230 QPS。峰值按平均的 5 到 10 倍算，取 2000 QPS。单实例 500 QPS 就需要 4 到 6 个实例，再加一倍冗余就是 8 到 12 个。
- 存储：每条记录 1KB，人均每天 10 条就是 10GB 每天，一年 3.6TB，加索引乘 1.5 约 5TB。单表超过 2000 万行或 50GB 就考虑分表，按这个量一年内必须分。
- 缓存：热点按总量的 20% 估，约 50GB，加副本和预留按 128GB 内存规划。Redis 单实例别超过 20GB，方便扩容和故障恢复。
- 带宽：图片按每张 100KB、人均每天 10 张算，出网峰值大概 1Gbps，必须走 CDN。

假设一定要写下来并和产品确认，比如人均请求数、留存、增长曲线。监控实际值与估算的偏差，偏差超过 2 倍就回头修模型，别让估算只做一次。`,
    points: ["先写清假设再算量级", "QPS 峰值按均值 5 到 10 倍", "给出存储与缓存的具体数字"],
    follow: "半年后日活涨到 500 万，哪一层会先扛不住？",
    sources: [
      { repo: "system-design-primer", path: "solutions/system_design/" },
      { repo: "tech-interview-handbook", path: "apps/portal/" },
    ],
  },
  {
    id: "system-design-short-url-service",
    category: "system",
    topic: "经典设计题",
    difficulty: 2,
    tags: ["短链", "发号器", "302"],
    question: "设计一个短链服务，QPS 十万，怎么分片和防冲突？",
    answer: `短链是典型的读多写少，读写比大约 100 比 1。读走缓存，写要保证短码唯一且不可枚举。

- 发号方案：不要用 hash 加冲突重试，高并发下会退化成反复查库。用全局发号器（号段或雪花）取自增 ID，再做 62 进制转换，6 位可表示 568 亿个，够用几十年。代价是 ID 连续可被遍历，要加固定盐做混淆或按位打散。
- 分片：按短码 hash 分 64 个库，写时先落库再写缓存。短码到长链的映射不可变，缓存 TTL 可以设很长甚至永久，只在删除时主动失效。
- 读路径：CDN 或本地缓存加 Redis，未命中回源并回填。跳转用 302 而不是 301，因为 301 会被浏览器长期缓存，点击统计就没了；代价是多一次请求，换回的是完整的点击数据。
- 存储：长链 hash 建唯一索引做去重，同一长链返回同一短码，省空间。

坑在防刷：创建接口按 IP 限流（每分钟 10 个），校验黑名单域名，跳转前查一次风险库。监控短码冲突率、缓存命中率、跳转 RT P99（目标 20ms 内）、创建接口限流次数。`,
    points: ["发号器加 62 进制，不用 hash 重试", "用 302 保留点击统计", "创建接口限流与黑名单"],
    follow: "短码被恶意遍历怎么办？",
    sources: [
      { repo: "system-design-primer", path: "solutions/system_design/pastebin/" },
      { repo: "advanced-java", path: "docs/high-concurrency/database-shard-global-id-generate.md" },
    ],
  },
  {
    id: "system-design-seckill-system",
    category: "system",
    topic: "经典设计题",
    difficulty: 3,
    tags: ["秒杀", "超卖", "库存扣减"],
    question: "设计秒杀系统，十万 QPS 抢一千件库存，怎么保证不超卖？",
    answer: `秒杀的关键是把九成流量挡在数据库之前，并保证扣减是原子的。

- 分层过滤：静态页面走 CDN 并在活动前预生成；前端按钮置灰加答题防脚本；网关按用户限流（同一用户 1 秒 1 次）并拦截重复请求；库存判断走 Redis，只有拿到资格的请求才进后端。
- 扣库存：Redis 用 Lua 脚本判断库存大于 0 再自减，原子且单线程无锁，单分片能扛十万 QPS。扣成功后发 MQ 异步创建订单并落库，前端轮询结果。代价是 Redis 与数据库短暂不一致，必须靠对账和补偿修复。
- 防超卖兜底：数据库扣减用带库存大于 0 条件的 update，靠行锁和影响行数判断，即使 Redis 出问题也不会超卖。代价是数据库 QPS 上限低，只能承载最终那少量请求。
- 防刷与公平：一人一单用 Redis setnx 加数据库唯一索引双保险，令牌桶放行，队列满了直接返回售罄而不是排队。

监控 Redis 与数据库的库存差值、订单创建成功率、MQ 堆积、接口 RT。活动结束立刻对账，差值不为 0 要能自动补偿退款。`,
    points: ["Redis Lua 原子扣减加数据库兜底", "分层过滤把流量挡在前面", "异步下单加对账补偿"],
    follow: "Redis 扣减成功但下单失败，库存怎么回滚？",
    sources: [
      { repo: "advanced-java", path: "docs/high-concurrency/" },
      { repo: "JavaGuide", path: "docs/database/redis/" },
    ],
  },
  {
    id: "system-design-feed-timeline",
    category: "system",
    topic: "经典设计题",
    difficulty: 3,
    tags: ["Feed流", "推拉结合", "游标分页"],
    question: "设计一个 Feed 流，大 V 有几千万粉丝，纯推模式怎么写？",
    answer: `纯推模式在大 V 发帖时要写几千万次，直接打爆；纯拉模式在用户打开时要聚合几百个关注，读延迟高。生产上都是推拉结合。

- 推模式：普通用户发帖直接写入粉丝收件箱（Redis List 或 zset，只保留最近 1000 条）。读的时候直接取，延迟十毫秒级。代价是写放大，粉丝数超过阈值就不适合。
- 拉模式：粉丝数超过 10 万的大 V 走拉模式，发帖只写自己的发件箱，用户读时把收件箱和大 V 发件箱做归并排序。代价是读时多查几次，要限制关注的大 V 数量并做并发查询。
- 混合策略：活跃粉丝（7 天内登录）走推，不活跃的走拉，能省七成以上的写。热榜和排行用 zset 按分数排，分页用游标而不是 offset，避免深分页。

坑在缓存容量：1000 万用户每人 1000 条 ID 就是几十 GB，要按活跃度分层存储，冷用户直接落库。监控收件箱写入延迟、归并查询耗时、缓存命中率、大 V 发帖的扩散耗时。`,
    points: ["推拉结合，大 V 走拉模式", "活跃度分层减少写放大", "游标分页避免深分页"],
    follow: "用户取关之后，收件箱里的历史帖子怎么处理？",
    sources: [
      { repo: "system-design-primer", path: "solutions/system_design/twitter/" },
      { repo: "JavaGuide", path: "docs/database/redis/" },
    ],
  },
  {
    id: "system-design-distributed-lock-choice",
    category: "system",
    topic: "经典设计题",
    difficulty: 3,
    tags: ["分布式锁", "Redlock", "fencing token"],
    question: "分布式锁 Redis 和 ZooKeeper 怎么选，锁失效怎么办？",
    answer: `先问能不能不用锁：唯一索引、状态机、乐观锁能解决的场景都比分布式锁可靠。锁只用于必须串行的场景，比如定时任务防重复执行。

- Redis 锁：加锁用带 nx 和过期时间的命令，value 放唯一请求 ID，释放时用 Lua 比对再删，避免误删别人的锁。代价是主从切换可能丢锁，Redlock 要求多数节点加锁成功，但实现复杂且有争议，网络抖动下可靠性仍有限。
- ZooKeeper 锁：临时顺序节点加 watch，会话断开自动释放，一致性强。代价是性能低，每次加解锁几十毫秒，且依赖 ZK 集群可用，适合并发不高的场景。
- 锁失效的根治办法是 fencing token：每次加锁拿一个单调递增的版本号，写数据时带上，存储层拒绝比当前版本小的写入。这样即使锁过期、两个线程并发，也只有最新的能写成功。

生产上锁的持有时间要远小于业务超时，TTL 取业务 P99 的 3 倍；后台线程续期能减少误释放，但进程卡死时续期也会停，所以 fencing 才是兜底。监控加锁失败率、锁等待时间、续期次数。`,
    points: ["Redis 与 ZK 锁的取舍对比", "Lua 比对后删避免误删", "fencing token 才是根治办法"],
    follow: "Redlock 到底安不安全，你怎么看？",
    sources: [
      { repo: "advanced-java", path: "docs/distributed-system/distributed-lock-redis-vs-zookeeper.md" },
      { repo: "JavaGuide", path: "docs/distributed-system/distributed-lock.md" },
    ],
  },
  {
    id: "system-observability-troubleshoot",
    category: "system",
    topic: "可观测性",
    difficulty: 2,
    tags: ["可观测性", "链路追踪", "告警分层"],
    question: "线上接口变慢，怎么用指标、日志、链路追踪定位？",
    answer: `先看指标定范围，再用链路定位到具体服务，最后看日志找根因。顺序不能反，否则就是在几百万行日志里瞎翻。

- 指标：先看入口 QPS、RT P99、错误率三件套，确认是全局还是单个接口，再看依赖的数据库、Redis、下游服务的 RT 和连接池使用率。单机问题看 CPU、GC 次数与耗时、线程池队列长度。指标回答的是哪一层的问题。
- 链路追踪：按 traceId 看这条请求的 span 瀑布图，找出耗时占比最大的那个 span。生产采样率一般 1% 到 10%，慢请求强制采样（超过 500ms 全采），要看的是 P99 的慢链路而不是平均。
- 日志：拿 traceId 去日志平台捞上下文，重点看异常栈、慢 SQL、重试次数。日志必须带 traceId、用户 ID、耗时，没有 traceId 的日志基本没用。

结论通常就三类：慢 SQL（加索引或改查询）、下游超时（补超时和降级）、GC 或线程池满（调参数或扩容）。告警要分层：入口错误率和 RT 是 P0 电话告警，资源水位是 P1，日志异常关键字是 P2，别所有告警都打电话。`,
    points: ["指标到链路到日志的排查顺序", "慢请求强制采样看 P99 链路", "日志必须带 traceId"],
    follow: "采样率只有 1%，出问题的请求没被采到怎么办？",
    sources: [
      { repo: "JavaGuide", path: "docs/system-design/basis/" },
      { repo: "tech-interview-handbook", path: "apps/portal/" },
    ],
  },
];
