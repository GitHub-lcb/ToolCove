// 面试题库 · 后端 · Redis / 消息队列 / Spring 生态。
// 本文件是「面试刷题」工具的纯数据模块，只导出 BACKEND_MIDDLEWARE_QUESTIONS 一个常量数组，
// 覆盖消息队列、Spring、Spring Cloud、MyBatis 与分布式五类主题，偏重机制理解与线上排查，
// 不依赖任何运行时、不发网络请求，由 UI 层按 topic 分组、按 difficulty 排序、按 tags 检索。
// 来源归属约定：每条 sources 只写「仓库 key + 仓库内相对路径前缀」，不写完整 URL，由 UI 侧拼回链；
// repo 限定为 JavaGuide / advanced-java / CS-Notes / athena / bestJavaer 五个键，
// path 必须是该仓库中真实存在的相对路径前缀。新增题目请沿用同一约定。
// 注意：question / points / follow 中不要出现花括号，会破坏应用内的 i18n 消息编译。

export const BACKEND_MIDDLEWARE_QUESTIONS = [
  {
    id: "backend-mq-kafka-vs-rocketmq",
    category: "backend",
    topic: "消息队列",
    difficulty: 2,
    tags: ["Kafka", "RocketMQ", "选型"],
    question: "Kafka 和 RocketMQ 都能做消息队列，选型时你会怎么比较？",
    answer: `结论：日志与流式管道优先 Kafka，业务消息的可靠投递、延迟与事务能力优先 RocketMQ。

- Kafka：分区顺序写加零拷贝，单机十万级吞吐，适合日志、埋点、流处理；但一个分区只能被同组内一个消费者消费，分区数决定并发上限，主题一多 Rebalance 抖动明显。
- RocketMQ：CommitLog 加 ConsumeQueue 的存储结构，延迟稳定在毫秒级，原生支持事务消息、延迟消息、消息轨迹与死信队列，主从加 DLedger 能自动切换。
- 生态：Kafka 有 Connect、Streams 与 Flink 生态；RocketMQ 与 Spring Cloud Alibaba、阿里云集成更顺。

实践：订单、支付这类要求不丢、可重试、可查轨迹的业务消息用 RocketMQ；日志与大数据管道用 Kafka。排查堆积先看消费位点与消费线程数是否匹配。`,
    points: ["按吞吐与延迟特性分场景", "RocketMQ 原生事务与延迟消息", "分区数决定 Kafka 消费并发"],
    follow: "Kafka 的分区数和消费者组是怎么配合的？",
    sources: [{ repo: "advanced-java", path: "docs/high-concurrency/" }, { repo: "JavaGuide", path: "docs/distributed-system/" }],
  },
  {
    id: "backend-mq-kafka-high-throughput",
    category: "backend",
    topic: "消息队列",
    difficulty: 2,
    tags: ["Kafka", "零拷贝", "顺序写", "高吞吐"],
    question: "Kafka 的吞吐为什么这么高？",
    answer: `结论：高吞吐来自顺序写盘、页缓存、零拷贝、批量压缩与分区并行叠加，不是某一个黑科技。

- 顺序追加：消息 append 到分区日志段，避免随机写，操作系统的预读与合并对顺序写也更友好。
- 页缓存：读写都走 OS page cache，JVM 堆很小、GC 压力小，消费跟得上时甚至不用读盘。
- 零拷贝：消费走 sendfile，数据从页缓存直接进网卡，省掉内核态与用户态之间的两次拷贝。
- 批量压缩：生产者按 batch.size 与 linger.ms 攒批，broker 以压缩块存储，成本按批摊薄。
- 分区并行：一个主题拆多个分区分布在多台 broker，生产与消费都能横向扩展。

实践：调吞吐先动 batch.size、linger.ms、compression.type，再看分区数与磁盘 fsync 策略。`,
    points: ["顺序追加写配合页缓存", "sendfile 零拷贝省两次拷贝", "批量压缩加分区横向扩展"],
    follow: "零拷贝具体省掉了哪几次内存拷贝？",
    sources: [{ repo: "advanced-java", path: "docs/high-concurrency/" }, { repo: "JavaGuide", path: "docs/distributed-system/" }],
  },
  {
    id: "backend-mq-message-loss",
    category: "backend",
    topic: "消息队列",
    difficulty: 3,
    tags: ["消息丢失", "ACK", "可靠性", "幂等"],
    question: "消息队列丢消息一般丢在哪几个环节？分别怎么防？",
    answer: `结论：丢消息只可能发生在生产端、Broker 端、消费端三处，要逐段确认并逐段加保险。

- 生产端：网络抖动或重试不足，消息没写进 broker。对策是同步发送并检查结果，Kafka 配 acks=all、调大 retries 并开 enable.idempotence 防重试重复；RocketMQ 判断 SendStatus。
- Broker 端：消息只在页缓存没落盘就宕机，或主从切换丢数据。对策是副本数至少 3、min.insync.replicas 至少 2、关闭 unclean 选举；RocketMQ 用同步刷盘加同步复制。
- 消费端：先提交位点再处理业务，处理失败消息就没了。对策是处理成功后再手动提交，Kafka 关掉 enable.auto.commit，RocketMQ 返回成功状态才推进位点。

实践：兜底是业务侧幂等加对账，比如本地消息表与定时补偿。`,
    points: ["生产端确认、重试加幂等", "Broker 多副本与同步刷盘", "消费端处理完再提交位点"],
    follow: "acks 设成 all 就一定能保证不丢吗？",
    sources: [{ repo: "advanced-java", path: "docs/high-concurrency/" }, { repo: "JavaGuide", path: "docs/distributed-system/" }],
  },
  {
    id: "backend-mq-transaction-delay",
    category: "backend",
    topic: "消息队列",
    difficulty: 3,
    tags: ["事务消息", "延迟消息", "最终一致性"],
    question: "事务消息和延迟消息分别怎么实现，适合什么场景？",
    answer: `结论：事务消息解决本地事务与发消息的原子性，延迟消息解决到点才触发的定时需求，两者都不是分布式事务的万能钥匙。

- 事务消息（RocketMQ）：生产者先发半消息，broker 存下来但对消费者不可见；本地事务成功后提交，失败则回滚；长时间没收到二次确认，broker 回查生产者的 checkLocalTransaction，据此决定投递还是丢弃。
- 延迟消息：RocketMQ 4.x 用固定 18 个延迟级别，到点由定时任务投到真实 topic，5.0 支持任意时间；Kafka 没有原生延迟消息，常见做法是自建时间轮或延时 topic 加转发服务。
- 场景：事务消息适合下单后通知积分、发券，追求最终一致；延迟消息适合超时未支付关单、预约提醒、失败重试退避。

实践：事务消息的回查次数有限，回查接口必须幂等且能按事务 ID 查到本地状态；延迟消息精度受扫描间隔影响，别拿它做精确调度。`,
    points: ["半消息加本地事务回查", "延迟级别到点定时投递", "关单与最终一致场景选型"],
    follow: "Kafka 想实现延迟消息，你会怎么设计？",
    sources: [{ repo: "advanced-java", path: "docs/high-concurrency/" }, { repo: "JavaGuide", path: "docs/distributed-system/" }],
  },
  {
    id: "backend-spring-bean-scope-thread-safety",
    category: "backend",
    topic: "Spring",
    difficulty: 1,
    tags: ["Bean 作用域", "单例", "线程安全"],
    question: "Spring 的 Bean 有哪些作用域？单例 Bean 线程安全吗？",
    answer: `结论：常用作用域是 singleton 与 prototype，Web 环境还有 request、session、application；单例 Bean 不保证线程安全，取决于它有没有可变状态。

- singleton：容器内一个实例，默认作用域，随容器启动创建，可用 lazy-init 延迟。
- prototype：每次 getBean 都新建，容器只负责创建，不负责销毁。
- request / session / application：Web 环境按请求、会话、上下文各一份。

关键是有没有共享可变字段。无状态的 Service、DAO 天生安全；在单例里写成员变量，比如缓存 Map 或 SimpleDateFormat，并发下就会出错。

实践：单例里只放不可变依赖与 ThreadLocal，且要在请求结束时 remove；需要状态就用 prototype 或加锁。`,
    points: ["singleton 与 prototype 的差别", "无状态 Bean 才天然安全", "可变成员变量与 ThreadLocal 风险"],
    follow: "prototype Bean 注入到单例 Bean 里会有什么问题？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/framework/spring/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-spring-transaction-propagation",
    category: "backend",
    topic: "Spring",
    difficulty: 2,
    tags: ["事务传播", "事务失效", "rollbackFor"],
    question: "Spring 事务的传播行为有哪些？事务为什么会失效？",
    answer: `结论：传播行为决定当前方法要不要复用外层事务，共 7 种；事务失效绝大多数是代理没生效或异常没被正确识别。

- 常用三种：REQUIRED 默认，有就加入、没有就新建；REQUIRES_NEW 挂起外层，自己开新事务；NESTED 用保存点，外层回滚会带着一起滚。
- 其余是 SUPPORTS、NOT_SUPPORTED、MANDATORY、NEVER，多用于只读或强制约束场景。

失效的常见原因：
- 方法不是 public，或同类内部自调用，代理被绕过。
- 异常被 catch 掉没抛出，或抛的是受检异常而默认只回滚运行时异常，要写 rollbackFor = Exception.class。
- 类没交给 Spring 管理，自己 new 的对象没有代理。
- 多数据源没配对应的事务管理器，或表引擎不支持事务。

实践：先确认调用链走没走代理，再看异常有没有被吞。`,
    points: ["REQUIRED 与 REQUIRES_NEW 的区别", "自调用与私有方法会失效", "rollbackFor 决定回滚范围"],
    follow: "REQUIRES_NEW 挂起外层事务时，数据库连接是怎么处理的？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/framework/spring/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-spring-aop-proxy-self-invocation",
    category: "backend",
    topic: "Spring",
    difficulty: 2,
    tags: ["AOP", "动态代理", "CGLIB", "自调用"],
    question: "Spring AOP 用了哪两种代理？为什么自调用会让增强失效？",
    answer: `结论：有接口的类默认用 JDK 动态代理，没有接口的用 CGLIB 生成子类；增强挂在代理对象上，自调用绕过代理自然失效。

- JDK 动态代理：基于 InvocationHandler 与接口生成代理类，目标类必须实现接口，注入时要用接口类型接收。
- CGLIB：用 ASM 生成子类并覆写方法，所以 final 类、final 方法与 private 方法都无法增强；Spring Boot 2.x 起默认走 CGLIB。

失效原因：方法里的 this 指向目标对象本身而不是代理对象，调用不经过拦截器链。典型场景是同一个 Service 里 A 方法调用本类的 B 方法，B 上的事务或缓存注解不生效。

实践：把 B 挪到另一个 Bean，或开启 exposeProxy 后用 AopContext.currentProxy 拿代理。`,
    points: ["JDK 代理要接口，CGLIB 要可继承", "this 调用不走拦截器链", "拆 Bean 或暴露当前代理"],
    follow: "CGLIB 代理为什么增强不了 final 方法？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/framework/spring/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-spring-boot-auto-configuration",
    category: "backend",
    topic: "Spring",
    difficulty: 1,
    tags: ["自动装配", "starter", "条件注解"],
    question: "Spring Boot 的自动装配是怎么实现的？starter 里有什么？",
    answer: `结论：自动装配靠启动类上的 @EnableAutoConfiguration 导入候选配置类，再由条件注解按依赖与配置决定装配哪些 Bean。

- 入口：它通过 AutoConfigurationImportSelector 读取 META-INF 下的 spring.factories，2.7 起换成 AutoConfiguration.imports。
- 过滤：条件注解按类路径有没有某个类、容器里有没有同类型 Bean、配置项是否开启来筛选，所以引了依赖没配属性不会硬塞，用户自定义的 Bean 优先。
- 顺序：配置类之间有先后约束，比如数据源先于持久层框架装配。
- starter：一个空 jar 做依赖聚合，再加一个自动配置模块放配置类与元数据文件。

实践：自己写 starter 时用 @ConfigurationProperties 接配置，并加缺失才装配的条件注解。`,
    points: ["EnableAutoConfiguration 导入配置类", "条件注解按需装配并可覆盖", "starter 是依赖聚合加配置"],
    follow: "ConditionalOnMissingBean 的判定结果为什么和配置类顺序有关？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/framework/spring/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-spring-cloud-nacos-registry-config",
    category: "backend",
    topic: "Spring Cloud",
    difficulty: 2,
    tags: ["Nacos", "注册中心", "配置中心", "长轮询"],
    question: "Nacos 同时做注册中心和配置中心，背后的原理是什么？",
    answer: `结论：注册靠心跳与健康检查维护实例列表，配置靠长轮询加 MD5 比对推送变更，两套能力共用同一份存储与集群。

- 注册发现：服务启动时把 ip、端口、集群、权重写入 Nacos。临时实例每 5 秒心跳续约，15 秒没续上标记不健康，30 秒剔除；持久化实例由服务端主动探测。客户端通过推送加定时拉取更新本地实例缓存。
- 配置管理：客户端发起长轮询，默认挂起 30 秒，服务端把请求放进队列，配置一变更立刻返回；客户端拿到后比对 MD5，变了才拉全量。相比固定间隔轮询，实时性更好、空轮询压力更小。
- 一致性：Nacos 1.x 里配置数据走 Raft、注册数据走 Distro 协议做最终一致；2.x 统一到 JRaft 加 gRPC 长连接。

实践：用命名空间隔离环境、分组隔离业务，配置加 @RefreshScope 才能热更新；集群至少三节点，别用内嵌 derby 存生产数据。`,
    points: ["心跳续约与健康检查剔除", "配置长轮询加 MD5 比对", "Raft 与 Distro 的一致性差异"],
    follow: "Nacos 的临时实例和持久化实例分别用在什么场景？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/framework/spring/" }, { repo: "advanced-java", path: "docs/distributed-system/" }],
  },
  {
    id: "backend-spring-cloud-openfeign-loadbalancer",
    category: "backend",
    topic: "Spring Cloud",
    difficulty: 2,
    tags: ["OpenFeign", "负载均衡", "LoadBalancer"],
    question: "OpenFeign 是怎么做服务调用和负载均衡的？",
    answer: `结论：OpenFeign 把接口方法翻译成 HTTP 请求，服务名由负载均衡组件解析成真实实例地址；Ribbon 停更后由 LoadBalancer 接管。

- 代理生成：启动时扫描 @FeignClient 接口，用 Contract 解析注解、Encoder 与 Decoder 编解码，生成 JDK 代理；调用时经 RequestInterceptor 加头。
- 地址解析：从注册中心按服务名拉实例列表缓存在本地，默认 35 秒刷新一次。
- 负载均衡：Ribbon 默认轮询并自带重试；LoadBalancer 提供轮询与随机两种策略，也能换成 Nacos 权重或同集群优先。

实践：超时别只配 Feign 的 connectTimeout 与 readTimeout，底层客户端也要配；重试必须保证幂等；排查 404 先对 path 与目标服务前缀。`,
    points: ["Feign 接口生成 JDK 代理", "客户端负载均衡挑选实例", "超时与重试必须配幂等"],
    follow: "Feign 的重试和负载均衡组件的重试叠加会有什么后果？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/framework/spring/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-spring-cloud-gateway-filters",
    category: "backend",
    topic: "Spring Cloud",
    difficulty: 2,
    tags: ["Gateway", "网关", "过滤器", "限流"],
    question: "Spring Cloud Gateway 的作用是什么？常用过滤器有哪些场景？",
    answer: `结论：网关是流量的统一入口，把路由转发、鉴权、限流、灰度、日志埋点这些横切逻辑从各个业务服务里收口。

- 模型：基于 WebFlux 与 Reactor Netty，全程非阻塞；请求先由断言匹配出路由，再走这条路由上的过滤器链。
- 内置过滤器：StripPrefix 去前缀、RewritePath 重写路径、RequestRateLimiter 基于 Redis 令牌桶限流、CircuitBreaker 熔断。
- 全局过滤器：实现 GlobalFilter 并指定顺序，对所有路由生效，常见的是校验 JWT、放 traceId、记录耗时。
- 动态路由：默认写在配置文件里，生产上一般存到 Nacos，监听变更后刷新路由定义。

实践：网关里不写业务逻辑，鉴权只做校验；限流按 IP 或用户设 key，并想好 Redis 故障时的降级。`,
    points: ["统一入口做鉴权限流灰度", "断言匹配加过滤器链", "动态路由与全局过滤器"],
    follow: "网关用 Redis 做令牌桶限流，可能有什么并发问题？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/framework/spring/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-spring-cloud-sentinel-degrade",
    category: "backend",
    topic: "Spring Cloud",
    difficulty: 3,
    tags: ["Sentinel", "熔断降级", "隔离策略"],
    question: "Sentinel 和 Hystrix 的隔离策略有什么区别？降级规则怎么配？",
    answer: `结论：Hystrix 默认用线程池隔离，靠独立线程池把故障挡在调用方之外；Sentinel 用并发线程数做信号量式控制，不额外起线程池，开销更小。

- 隔离：Hystrix 线程池隔离能设超时、支持异步，代价是每个依赖一个线程池，切换与上下文传递成本高，也可切成信号量隔离。Sentinel 统计当前资源的并发线程数流控，被挡住时走 blockHandler。
- 熔断降级：Sentinel 有慢调用比例、异常比例、异常数三种策略，达到最小请求数与阈值后，在时间窗口内熔断，窗口内请求直接走 fallback。
- 限流：流控模式分直接、关联、链路，效果有快速失败、预热与匀速排队。

实践：Sentinel 规则默认存内存，重启就没了，生产要接 Nacos 或 Apollo 持久化；blockHandler 与 fallback 要和原方法同签名同返回类型；降级返回兜底数据而不是抛异常。`,
    points: ["Hystrix 线程池隔离开销更大", "Sentinel 三种熔断策略", "规则持久化到 Nacos"],
    follow: "Sentinel 的匀速排队是怎么实现的？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/framework/spring/" }, { repo: "advanced-java", path: "docs/distributed-system/" }],
  },
  {
    id: "backend-spring-mybatis-executor-cache",
    category: "backend",
    topic: "MyBatis",
    difficulty: 2,
    tags: ["MyBatis", "一级缓存", "SqlSession"],
    question: "MyBatis 执行一条 SQL 经历了什么？一二级缓存有什么区别和坑？",
    answer: `结论：一次查询经过 SqlSession、Executor、StatementHandler、ParameterHandler、ResultSetHandler 五层；一级缓存是会话级，二级是命名空间级。

- 执行流程：Mapper 代理把方法转成 MappedStatement，Executor 先查缓存，未命中就让 StatementHandler 执行、ResultSetHandler 映射结果。
- 一级缓存：默认开启且关不掉，作用域是同一个 SqlSession，语句、参数与 SQL 一致才命中；执行 update、清缓存、提交或回滚都会清空。
- 二级缓存：要打开 cacheEnabled 并在 Mapper 上声明，跨 SqlSession 共享，但对象必须可序列化，多表关联容易脏读。

实践：同一会话里用别的连接改了库，再查同一条 SQL 会拿到旧值。`,
    points: ["五层组件完成一次查询", "一级缓存随会话与更新清空", "二级缓存跨会话容易脏读"],
    follow: "一级缓存和 Spring 事务放在一起会有什么问题？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/framework/mybatis/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-distributed-id-snowflake",
    category: "backend",
    topic: "分布式",
    difficulty: 2,
    tags: ["分布式 ID", "雪花算法", "时间回拨"],
    question: "分布式 ID 有哪些方案？雪花算法的时间回拨怎么解决？",
    answer: `结论：常见方案有数据库号段、Redis 自增、UUID 与雪花算法，选型看是否要趋势递增、能否依赖外部组件。

- 数据库号段：一次取一批 ID 缓存在内存，大幅降低数据库压力，美团 Leaf 号段模式即此，缺点是重启浪费一段。
- Redis 自增：用 INCR 或 INCRBY 取 ID，性能好但依赖 Redis 可用性，持久化没配好重启会重号。
- UUID：本地生成、无网络开销，但无序且占空间，做主键会拖慢 InnoDB 插入。
- 雪花算法：1 位符号加 41 位毫秒时间戳、10 位机器位、12 位序列号，本地生成且趋势递增，代价是依赖时钟。

时间回拨的处理：幅度小就等待追平；幅度大直接拒绝并告警；也可用备用位记录回拨次数，或把机器位交给 ZooKeeper 分配。

实践：上线必须校验 workerId 唯一，NTP 同步避免跳变，并准备降级预案。`,
    points: ["号段、Redis、UUID、雪花对比", "雪花等于时间戳加机器位加序列", "回拨靠等待、拒绝或备用位"],
    follow: "workerId 重复会导致什么后果，怎么保证唯一？",
    sources: [{ repo: "JavaGuide", path: "docs/distributed-system/" }, { repo: "advanced-java", path: "docs/distributed-system/" }],
  },
  {
    id: "backend-distributed-lock-implementations",
    category: "backend",
    topic: "分布式",
    difficulty: 3,
    tags: ["分布式锁", "Redisson", "ZooKeeper"],
    question: "分布式锁有哪几种实现？各自有什么缺陷？",
    answer: `结论：主流是 Redis、ZooKeeper 与数据库三种；Redis 性能好但一致性有争议，ZooKeeper 更稳但性能低。

- Redis：用 SET 带 NX 与 PX 加锁，value 存唯一标识，解锁必须用 Lua 脚本比对后再删，否则会删掉别人的锁。缺陷是主从异步复制，主挂了锁没同步过去会出现两人同时持锁；Redlock 靠多数派缓解，但仍依赖时钟。
- Redisson：用 Hash 存重入次数，不指定过期时间时启动看门狗，默认 30 秒并每 10 秒续期，避免业务没跑完锁就过期。
- ZooKeeper：在锁节点下创建临时顺序节点，自己是最小节点则持锁，否则监听前一个节点；会话断开自动删除临时节点，天然不死锁。
- 数据库：唯一索引插入或 select for update，实现简单但并发差，只适合低频场景。

实践：锁粒度尽量小，加锁必须设超时，业务仍要幂等。`,
    points: ["Redis 用 SET NX PX 加 Lua 解锁", "Redisson 看门狗自动续期", "ZK 临时顺序节点避免死锁"],
    follow: "看门狗续期时进程假死了会怎么样？",
    sources: [{ repo: "JavaGuide", path: "docs/distributed-system/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "backend-distributed-transaction-patterns",
    category: "backend",
    topic: "分布式",
    difficulty: 3,
    tags: ["分布式事务", "TCC", "Seata", "最终一致性"],
    question: "分布式事务有哪几种解决方案？实际项目里怎么选？",
    answer: `结论：强一致场景很少，绝大多数业务用最终一致性就够；常见方案是 2PC、TCC、本地消息表、事务消息与 Seata AT。

- 2PC：准备与提交两阶段，强一致但同步阻塞、协调者单点，性能差，只适合内部短事务。
- TCC：Try 预留资源、Confirm 确认、Cancel 补偿，业务侵入大，必须处理空回滚、幂等与悬挂，适合资金、库存这类场景。
- 本地消息表：业务写库与写消息表在同一个本地事务里，再由定时任务投递并重试，简单可靠，缺点是耦合业务库且有延迟。
- 事务消息：RocketMQ 的半消息加回查，本质是本地消息表的托管版，省掉自己建表与轮询。
- Seata AT：靠 undo_log 记录前后镜像，一阶段提交本地事务并注册分支，二阶段提交就删日志、回滚就反向补偿，几乎无侵入，但要关注全局锁冲突。

实践：能不用就不用，先把服务边界划清；允许延迟就用消息表或事务消息。`,
    points: ["2PC 强一致但同步阻塞", "TCC 要处理三个异常", "消息表与事务消息成本最低"],
    follow: "Seata AT 模式的全局锁是什么时候释放的？",
    sources: [{ repo: "JavaGuide", path: "docs/distributed-system/" }, { repo: "advanced-java", path: "docs/distributed-system/" }],
  },
];
