// 面试题库 · 后端 · 并发与多线程。
// 本文件是「面试刷题」工具的离线题库数据源之一，只导出 BACKEND_CONCURRENCY_QUESTIONS 一个常量数组，
// 覆盖 JMM 与 happens-before、volatile 语义、synchronized 锁升级、AQS、CAS 与 ABA、ThreadLocal、
// 线程池参数与治理、同步工具选型、死锁定位、JDK 21 虚拟线程这些后端面试高频考点。
// 每道题的 sources 只记录「来源仓库 + 仓库内相对路径」，用于标注知识出处，不写完整 URL；
// repo 限定为 JavaGuide / advanced-java / CS-Notes / athena / bestJavaer 五个键，
// path 必须是该仓库中真实存在的相对路径前缀。新增题目请沿用同一约定。
// 注意：question / points / follow 中不要出现花括号，会破坏应用内的 i18n 消息编译。

export const BACKEND_CONCURRENCY_QUESTIONS = [
  {
    id: "backend-concurrent-jmm-reordering-barriers",
    category: "backend",
    topic: "JMM",
    difficulty: 2,
    tags: ["JMM", "重排序", "内存屏障", "as-if-serial"],
    question: "指令重排序有哪几种？JMM 用什么手段禁止它？",
    answer: `重排序有三种来源：编译器重排、CPU 乱序执行、内存系统重排（写缓冲与失效队列让读写看起来换了序）。单线程下它们受 as-if-serial 语义约束，结果不变，所以很难靠调试发现。

JMM 靠内存屏障约束它们：

- 屏障有 LoadLoad、StoreStore、LoadStore、StoreLoad 四种。volatile 写前插 StoreStore、写后插 StoreLoad，读后插 LoadLoad 与 LoadStore。
- 屏障让前后的指令不能越界，代价是流水线停顿，所以不是越多越好。x86 上只有 StoreLoad 需要真正的 lock 前缀指令。

最容易踩的是双重检查锁定：instance 赋值与对象初始化会被重排，别的线程可能拿到半成品，必须加 volatile；用普通字段做初始化完成标志同样不安全。`,
    points: ["重排序的三种来源", "四种屏障与 volatile 插入点", "双重检查锁定必须加 volatile"],
    follow: "as-if-serial 和 happens-before 是什么关系？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-concurrent-volatile-semantics",
    category: "backend",
    topic: "JMM",
    difficulty: 1,
    tags: ["volatile", "可见性", "原子性", "内存屏障"],
    question: "volatile 的两个语义是什么？为什么它保证不了原子性？",
    answer: `两个语义是可见性和有序性。

- 可见性：写 volatile 变量时 JIT 会插入 lock 前缀指令，把写缓冲刷回主内存并让其他 CPU 的对应缓存行失效；读的时候强制从主内存重新加载。所以一个线程改了，另一个线程立刻能看到。
- 有序性：编译器和 CPU 不能把 volatile 写之前的操作排到它后面，也不能把 volatile 读之后的操作排到它前面，相当于插入了内存屏障。

它保证不了原子性，因为 volatile 只约束单个读或单个写的可见性，不提供互斥。i++ 是读、改、写三步，两个线程可能都读到旧值再写回，结果少加一次。要原子性得用 synchronized、ReentrantLock 或 AtomicInteger 的 CAS。

实践中 volatile 只适合状态标志位、一次性安全发布这类单写多读的场景。`,
    points: ["可见性与有序性两个语义", "lock 前缀与内存屏障的作用", "i++ 拆成三步所以不原子"],
    follow: "双重检查锁定的单例为什么必须给 instance 加 volatile？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-concurrent-synchronized-lock-upgrade",
    category: "backend",
    topic: "锁",
    difficulty: 2,
    tags: ["synchronized", "锁升级", "偏向锁", "对象头"],
    question: "synchronized 的锁升级过程是怎样的？偏向锁为什么被移除？",
    answer: `synchronized 的锁状态记录在对象头 Mark Word 里，随竞争升级：无锁、偏向锁、轻量级锁、重量级锁，不可逆。

- 偏向锁：只有一个线程反复进入时把线程 ID 写进 Mark Word，之后同一线程进入不用 CAS。JDK 15 起默认禁用、JDK 18 移除，因为撤销要等安全点。
- 轻量级锁：第二个线程竞争时撤销偏向，线程在栈帧里建 Lock Record，用 CAS 指向它，失败就自旋。
- 重量级锁：自旋失败后膨胀成 ObjectMonitor，竞争失败的线程进 EntryList 阻塞，涉及内核态切换。

同步块编译成 monitorenter 与 monitorexit 字节码，方法上的 synchronized 是 ACC_SYNCHRONIZED 标志。排查用 jstack 看 BLOCKED 线程或 Arthas。`,
    points: ["锁状态存在对象头 Mark Word", "偏向到轻量级的升级条件", "JDK 18 移除偏向锁的原因"],
    follow: "轻量级锁自旋失败后是怎么膨胀成重量级锁的？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "backend-concurrent-aqs-principle",
    category: "backend",
    topic: "锁",
    difficulty: 3,
    tags: ["AQS", "同步器", "CLH 队列", "模板方法"],
    question: "AQS 的原理是什么？它支撑了哪些同步器？",
    answer: `AQS 即 AbstractQueuedSynchronizer，核心是 volatile 的 state 加一条 CLH 双向等待队列。子类只实现 tryAcquire、tryRelease 这类模板方法，排队与阻塞交给 AQS。

- state 表示同步状态：ReentrantLock 里是重入次数，Semaphore 里是剩余许可，CountDownLatch 里是剩余计数，ReentrantReadWriteLock 用它记读写锁持有数。
- 失败就包成 Node 入队，用 LockSupport.park 阻塞；释放时唤醒后继节点。
- 支持独占与共享两种模式，Condition 用 ConditionObject 队列实现 await 与 signal。

排查看 jstack 里 waiting on condition 的线程；坑多在漏掉重入或中断。`,
    points: ["state 加 CLH 双向队列", "子类只实现模板方法", "支撑 Lock 与 CountDownLatch"],
    follow: "ReentrantLock 的非公平锁具体是怎么抢锁的？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-concurrent-reentrantlock-vs-synchronized",
    category: "backend",
    topic: "锁",
    difficulty: 2,
    tags: ["ReentrantLock", "synchronized", "锁", "选型"],
    question: "ReentrantLock 和 synchronized 你会怎么选？",
    answer: `结论是能用 synchronized 就用它，需要它的独有能力时才换 ReentrantLock。

synchronized 是关键字，由 JVM 实现，加解锁自动成对不会忘记释放，JDK 6 后的锁优化让它性能已接近 ReentrantLock。

ReentrantLock 基于 AQS，多出四样能力：

- 可中断获取：lockInterruptibly 能响应中断，避免线程无限等待。
- 超时获取：tryLock 带时间参数，拿不到返回 false，方便降级。
- 公平锁：构造传 true，按排队顺序获取，缓解饥饿。
- 多条件队列：一把锁 new 出多个 Condition 做精确唤醒，ArrayBlockingQueue 就靠它。

代价是 unlock 必须写在 finally 里，漏写就是永久死锁；读写分离直接用 ReentrantReadWriteLock。`,
    points: ["synchronized 自动释放更省心", "ReentrantLock 的四样独有能力", "unlock 必须写在 finally 里"],
    follow: "读写锁和 StampedLock 应该怎么选？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-concurrent-fair-vs-nonfair-lock",
    category: "backend",
    topic: "锁",
    difficulty: 2,
    tags: ["公平锁", "非公平锁", "ReentrantLock", "饥饿"],
    question: "公平锁和非公平锁有什么区别？为什么默认是非公平的？",
    answer: `公平锁严格按等待队列顺序发放锁，非公平锁允许新来的线程直接 CAS 抢锁，抢不到再排队。ReentrantLock 默认非公平，构造传 true 才是公平锁；synchronized 也是非公平的。

- 公平锁唤醒队首线程要经历一次上下文切换，被唤醒的线程还得重新参与竞争，这段时间锁很可能又空了。
- 非公平锁让刚释放锁的线程有机会立刻再次拿到锁，减少切换，实测吞吐更高，代价是队列里的线程可能长时间饥饿。

所以只在任务耗时差异大、必须避免饥饿时才开公平锁。判断饥饿看 jstack 里同一线程反复持有 monitor，或者统计每个线程的等待时长。`,
    points: ["公平锁按队列顺序发放", "非公平减少上下文切换", "吞吐优先所以默认非公平"],
    follow: "线上怎么判断真的出现了线程饥饿？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-concurrent-cas-aba",
    category: "backend",
    topic: "并发",
    difficulty: 2,
    tags: ["CAS", "ABA", "AtomicStampedReference", "自旋"],
    question: "CAS 是什么？ABA 问题怎么解决？",
    answer: `CAS 是一条 CPU 原子指令，x86 上是 cmpxchg，比较内存地址、期望值、新值，只有当前值等于期望值才写入。Java 通过 Unsafe 的 compareAndSwapInt 暴露，AtomicInteger、AQS 都在用。

它有三个坑：

- ABA：值从 A 改成 B 又改回 A，CAS 检查不出中间变化，链表场景会丢节点。用 AtomicStampedReference 把版本号一起 CAS，或用 AtomicMarkableReference 加布尔标记。
- 自旋开销：竞争激烈时大量 CAS 空转，CPU 飙高但吞吐不涨，通常改用 LongAdder 分散热点。
- 只能保证单个变量的原子性，多变量要用 AtomicReference 打包。

排查时 jstack 看到大量线程停在 atomic 相关方法、CPU 高但吞吐低，多半就是 CAS 自旋。`,
    points: ["CAS 三个操作数与原子指令", "ABA 用版本号解决", "自旋开销与单变量限制"],
    follow: "LongAdder 为什么比 AtomicLong 快？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "backend-concurrent-threadlocal-leak",
    category: "backend",
    topic: "并发",
    difficulty: 2,
    tags: ["ThreadLocal", "内存泄漏", "InheritableThreadLocal", "线程池"],
    question: "ThreadLocal 的原理是什么？为什么会内存泄漏？",
    answer: `每个 Thread 内部有一个 ThreadLocalMap 字段，key 是 ThreadLocal 对象的弱引用，value 是强引用。数据挂在线程上，线程不结束数据就在，这也是线程隔离的来源。

- 泄漏源于引用强度不一致：ThreadLocal 对象被方法栈释放后 key 变成 null，value 仍被 Entry 强引用，而 Entry 挂在 Thread 上。
- 线程池里的线程复用、几乎不销毁，value 一路累积到 OOM；JDK 只在 set、get 时顺带清理 key 为 null 的 Entry。

正确用法是在 finally 里 remove。子线程继承用 InheritableThreadLocal，它在 new Thread 时复制父线程的值；线程池里线程预先创建、复制不会发生，要用 TransmittableThreadLocal 包装任务。`,
    points: ["数据挂在线程的 ThreadLocalMap", "key 弱引用而 value 强引用", "finally 里 remove 兜底"],
    follow: "TransmittableThreadLocal 是怎么跨线程池传递值的？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-concurrent-thread-pool-params",
    category: "backend",
    topic: "线程池",
    difficulty: 2,
    tags: ["线程池", "ThreadPoolExecutor", "拒绝策略", "阻塞队列"],
    question: "ThreadPoolExecutor 的核心参数有哪些？任务提交后怎么走？",
    answer: `七个参数：corePoolSize、maximumPoolSize、keepAliveTime、unit、workQueue、threadFactory、handler。

提交流程四步：核心线程没满就直接建；满了进任务队列排队；队列满且线程数没到最大值就建非核心线程；都满则拒绝。

- 队列选型：ArrayBlockingQueue 有界最稳；LinkedBlockingQueue 默认容量 Integer.MAX_VALUE 等于无界，maximumPoolSize 会失效；SynchronousQueue 不存储。

拒绝策略默认 AbortPolicy，抛 RejectedExecutionException；CallerRunsPolicy 让提交线程自己跑形成反压；另两种分别静默丢弃和丢弃最老任务。`,
    points: ["七个核心参数分别是什么", "execute 的四步提交流程", "队列选型与四种拒绝策略"],
    follow: "线程池里的任务抛异常了会怎样？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "backend-concurrent-thread-pool-size",
    category: "backend",
    topic: "线程池",
    difficulty: 1,
    tags: ["线程池", "核心线程数", "CPU 密集型", "IO 密集型"],
    question: "线程池的核心线程数怎么定？CPU 密集和 IO 密集一样吗？",
    answer: `结论是先按任务类型估一个初值，再靠压测和监控调，不要照抄公式。

- CPU 密集型：线程数约等于核数加一，即 Runtime.getRuntime().availableProcessors() + 1，多出来的一个用来顶替偶发的缺页中断。再大只会增加上下文切换。
- IO 密集型：线程大部分时间在等网络或磁盘，可以用 核数 × (1 + 平均等待时间 / 平均计算时间) 估算，数据库和 RPC 调用多的服务这个倍数常见是 2 到 10。

公式只能给起点：压测出 QPS 与 RT 之后，看线程池的 activeCount、queueSize 和拒绝次数逐步调整。同时按业务拆分线程池，把下单、查询、日志分开，避免一个慢任务拖死整池。

另外核心业务不要用 Executors 创建线程池，FixedThreadPool 用的是无界队列，风险等同于 OOM。`,
    points: ["CPU 密集取核数加一", "IO 密集按等待时间估算", "最终靠压测与监控调整"],
    follow: "线程池队列积压了你会怎么应急处理？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-concurrent-thread-pool-shutdown",
    category: "backend",
    topic: "线程池",
    difficulty: 3,
    tags: ["线程池", "优雅关闭", "监控", "shutdown"],
    question: "线上怎么监控线程池？停机时怎么优雅关闭？",
    answer: `监控上 ThreadPoolExecutor 暴露了 getActiveCount、getQueue().size()、getPoolSize，拒绝次数要自己包一层拒绝处理器计数。指标接 Prometheus，重点看队列积压和活跃线程数是否长期打满，持续增长说明线程不够或下游变慢。

更细的可以重写 beforeExecute、afterExecute 统计任务耗时，定位是谁占住了池；线程命名要带业务前缀。

优雅关闭分三步：

- 先停止接收新任务，一般是摘掉注册中心流量。
- 调 shutdown()，不再接新任务但会把队列执行完；要丢队列用 shutdownNow()，它返回未执行任务并中断线程。
- awaitTermination 等待，返回 false 说明还有任务没结束，记日志再决定强杀。

注意 shutdownNow 靠中断生效，任务吞掉中断就停不下来。`,
    points: ["采集队列与活跃线程数", "shutdown 与 shutdownNow 区别", "awaitTermination 做兜底"],
    follow: "Spring 的 ThreadPoolTaskExecutor 怎么优雅停机？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "backend-concurrent-sync-tools-scenarios",
    category: "backend",
    topic: "并发",
    difficulty: 2,
    tags: ["CountDownLatch", "CyclicBarrier", "Semaphore", "CompletableFuture"],
    question: "CountDownLatch、CyclicBarrier、Semaphore 各自适合什么场景？",
    answer: `三者语义不同，不能混用。

- CountDownLatch：一次性倒计数器，主线程 await 等 N 个子任务 countDown 到零，适合一个线程等多个线程完成，比如并行加载多个数据源，计数不能重置。
- CyclicBarrier：可循环栅栏，N 个线程互相等，全部到达后一起继续，到达时可执行一个 Runnable，适合分片跑批每轮同步一次。
- Semaphore：许可池，acquire 拿许可、release 还许可，用来限流而不是同步，比如限制访问下游的并发数为 10。

CompletableFuture 是编排工具：thenCompose 串行依赖、thenCombine 聚合、allOf 等全部完成、exceptionally 兜底异常；默认用 ForkJoinPool.commonPool，IO 任务要传自定义线程池。`,
    points: ["Latch 一次性等待完成", "Barrier 可循环互相等待", "Semaphore 限流不做同步"],
    follow: "CompletableFuture 的异常怎么统一处理？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-concurrent-deadlock-diagnosis",
    category: "backend",
    topic: "并发",
    difficulty: 3,
    tags: ["死锁", "jstack", "线上排查", "循环等待"],
    question: "死锁的四个必要条件是什么？线上怎么定位？",
    answer: `四个必要条件缺一不可：互斥，资源同一时刻只能被一个线程占用；请求并保持，拿着锁还去申请新锁；不可剥夺，锁只能由持有者释放；循环等待，存在线程与锁的环形等待链。

定位步骤：

- jps 或 ps 找到 Java 进程号。
- jstack 打印线程栈，末尾会自动做死锁检测，输出 Found one Java-level deadlock 以及互相持有的锁；jconsole、VisualVM 也有检测死锁的按钮。
- Arthas 的 thread -b 直接找出阻塞其他线程最多的那个线程。

修复上打破任意一个条件即可：统一所有线程的加锁顺序最常用，或者用带超时的 tryLock，拿不到就释放已持有的锁。

生产中更常见的是锁等待而不是严格死锁，比如线程池里任务互相等对方的子任务结果，本质是线程池隔离没做好，jstack 只会看到一片 WAITING。`,
    points: ["四个必要条件缺一不可", "jstack 自动检测死锁", "统一加锁顺序最常用"],
    follow: "线程池里任务互相等待算死锁吗？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-concurrent-visibility-atomicity-ordering",
    category: "backend",
    topic: "JMM",
    difficulty: 3,
    tags: ["可见性", "原子性", "有序性", "指令重排"],
    question: "并发问题分哪几类？每一类分别用什么手段解决？",
    answer: `分三类，对应 JMM 要解决的三个问题。

- 可见性：一个线程改了共享变量，另一个线程看不到，因为它读的是工作内存或 CPU 缓存。对策是 volatile、synchronized、final 字段的安全发布，本质都是插入内存屏障。
- 原子性：i++ 这类读改写被拆开，或者对象只构造了一半就被别的线程看到。对策是 synchronized、Lock、Atomic 系列的 CAS；跨多个变量的复合操作必须用锁，Atomic 只能保证单变量。
- 有序性：编译器重排、CPU 乱序执行、内存系统重排，让别的线程先看到结果后看到标志位，经典案例是双重检查锁定的单例必须给 instance 加 volatile。对策是 volatile 和锁，它们同时提供可见性与有序性。

排查顺序：先看变量有没有被多线程写，再判断是不是复合操作，最后看有没有跨线程发布，复现可以用 jcstress。`,
    points: ["三类问题分别是什么", "volatile 与锁的对策", "按变量和操作逐步排查"],
    follow: "final 字段的安全发布在底层是怎么实现的？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-concurrent-virtual-thread",
    category: "backend",
    topic: "虚拟线程",
    difficulty: 3,
    tags: ["虚拟线程", "JDK 21", "Virtual Thread", "pinning"],
    question: "JDK 21 的虚拟线程解决了什么问题？哪些场景不适合？",
    answer: `虚拟线程解决的是高并发 IO 下平台线程太贵的问题，不是让 CPU 计算变快。

平台线程一对一映射内核线程，栈默认约 1MB，几千个就到瓶颈。虚拟线程由 JVM 调度，栈存在堆里按需增长，可创建百万级；它跑在少量载体线程上，默认是并行度等于核数的 ForkJoinPool，遇到阻塞 IO 就把栈挂起、让出载体线程，所以阻塞不再白占线程。

不适合的场景：

- CPU 密集型任务不会加速，反而多一层调度开销。
- synchronized 块里做阻塞操作会把虚拟线程钉在载体线程上，JDK 24 才解决，应改用 ReentrantLock。
- 用 ThreadLocal 缓存大对象，每个都存一份会撑爆内存，应改用 ScopedValue。
- 池化没有意义，创建成本极低，不要用线程池包装。

排查 pinning 用 -Djdk.tracePinnedThreads=full。`,
    points: ["平台线程贵在哪里", "阻塞时让出载体线程", "pinning 与 ThreadLocal 的坑"],
    follow: "虚拟线程和响应式编程应该怎么选？",
    sources: [{ repo: "JavaGuide", path: "docs/java/new-features/" }, { repo: "CS-Notes", path: "docs/" }],
  },
];
