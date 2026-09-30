// 面试题库 · Java 后端 / 八股。
// 本文件是「面试刷题」工具的离线题库数据源之一，只导出 BACKEND_QUESTIONS 一个常量数组，
// 不依赖任何运行时、不发网络请求，由 UI 层按 topic 分组、按 difficulty 排序、按 tags 检索。
// 每道题的 sources 只记录「来源仓库 + 仓库内相对路径」，用于标注知识出处，不写完整 URL；
// repo 限定为 JavaGuide / advanced-java / CS-Notes / athena / bestJavaer 五个键，
// path 必须是该仓库中真实存在的相对路径前缀。新增题目请沿用同一约定。
// 注意：question / answer / points / follow 中不要出现花括号，会破坏应用内的 i18n 消息编译。

export const BACKEND_QUESTIONS = [
  {
    id: "backend-jvm-classloader",
    category: "backend",
    topic: "JVM",
    difficulty: 2,
    tags: ["JVM", "类加载", "双亲委派", "ClassLoader"],
    question: "双亲委派模型是什么？为什么需要它，又怎么打破？",
    answer: `类加载器分三层：Bootstrap 加载核心类库，Extension 在 JDK 9 后改名 Platform 加载扩展类，Application 加载应用 classpath。收到加载请求时先委派给父加载器，父加载器加载不了才自己加载。

这么做有两个目的：一是避免重复加载，同一个类被不同加载器加载会得到不同的 Class 对象，类型判断会出错；二是沙箱安全，用户自己写一个 java.lang.String 也永远会被 Bootstrap 抢先加载，改不了核心库。

打破的方式有三种：

- 重写 loadClass 方法不走委派逻辑，Tomcat 的 WebAppClassLoader 就是这样，Web 应用优先加载自己 WEB-INF 下的类，实现应用间隔离。
- 用线程上下文类加载器，SPI 场景下核心库由 Bootstrap 加载但实现类在应用 classpath，JDBC 驱动就是靠 Thread.currentThread().getContextClassLoader 拿到的。
- 模块化热部署，OSGi 把委派变成了网状结构。

排查 ClassNotFoundException 时先确认类在不在、再由哪个加载器加载，用 -verbose:class 或 Arthas 的 classloader 命令看。`,
    points: ["三层加载器与委派流程", "避免重复加载和沙箱安全", "重写 loadClass 与 SPI 打破"],
    follow: "Tomcat 为什么要打破双亲委派？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-jvm-oom-troubleshoot",
    category: "backend",
    topic: "JVM",
    difficulty: 3,
    tags: ["JVM", "OOM", "内存泄漏", "故障排查"],
    question: "线上服务 OOM 了，你的排查思路是什么？",
    answer: `第一原则是先留现场再重启。启动参数加上堆转储开关和转储路径，让 OOM 时自动落盘，同时打上时间戳，别让重启把证据冲掉。

接着判断性质：是内存泄漏还是内存确实不够。

- 用 jstat 看各代使用率和 Full GC 次数。回收后老年代降不下来、且 FGC 越来越频繁，基本是泄漏；每次都能回收干净但很快又满，是堆太小或者流量涨了。
- 用 jmap 看对象直方图，找实例数和占用最高的类；再用 MAT 打开 dump，看支配树和到 GC Roots 的最短引用链。

常见泄漏源就那么几类：静态 Map 当缓存只加不减、ThreadLocal 用完不 remove、连接和流没关、一次性把大表全查出来、元空间因为动态代理或热部署反复生成类而涨爆。

\`\`\`bash
jstat -gcutil 12345 1000
jmap -histo:live 12345 | head -30
\`\`\`

定位到具体代码再谈扩容，否则加内存只是把事故推迟几周。平时把堆使用率、FGC 频率、老年代增长速率做成告警，比出事后再查有用得多。`,
    points: ["先保留堆 dump 现场再重启", "用 jstat 和 jmap 区分泄漏与不足", "静态集合、ThreadLocal、元空间泄漏"],
    follow: "怎么区分内存泄漏和内存溢出？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "bestJavaer", path: "docs/" }],
  },

  {
    id: "backend-concurrent-jmm-happens-before",
    category: "backend",
    topic: "并发",
    difficulty: 2,
    tags: ["并发", "JMM", "happens-before", "重排序"],
    question: "JMM 是什么？happens-before 规则解决了什么问题？",
    answer: `JMM 是 Java 内存模型，定义了多线程读写共享变量时的可见性、有序性和原子性规则，屏蔽掉不同 CPU 架构和编译器的差异，让程序在所有平台上表现一致。

抽象上每个线程有自己的工作内存，对应 CPU 缓存和寄存器，共享变量存在主内存。线程读写要先拷贝到工作内存，这就是可见性问题的来源。

happens-before 是给开发者看的可见性契约：如果 A happens-before B，那么 A 的结果对 B 可见，且 A 在 B 之前发生。主要几条：

- 程序顺序规则：同一线程内前面的操作先于后面的。
- 监视器锁规则：解锁先于后续对同一把锁的加锁。
- volatile 规则：对 volatile 变量的写先于后续的读。
- 线程启动规则：start 调用先于线程内所有操作。
- 线程终止规则：线程内所有操作先于 join 返回。
- 传递性：A 先于 B、B 先于 C，则 A 先于 C。

它约束的是可见性而不是执行顺序。只要不改变单线程语义，编译器和 CPU 可以任意重排序，JMM 就是通过禁止某些重排序来兑现这些契约的。`,
    points: ["工作内存与主内存的抽象", "happens-before 是可见性契约", "六条主要规则和传递性"],
    follow: "重排序在什么情况下不会发生？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-concurrent-volatile",
    category: "backend",
    topic: "并发",
    difficulty: 2,
    tags: ["并发", "volatile", "可见性", "内存屏障"],
    question: "volatile 保证了什么？为什么不保证原子性？",
    answer: `保证可见性和有序性，不保证原子性。

可见性：写 volatile 变量时把工作内存的值刷回主内存，读之前从主内存重新加载，底层靠 lock 前缀指令和 StoreLoad 屏障实现。

有序性：JSR-133 增强后，volatile 写之前的所有操作不能排到写之后，读之后的所有操作不能排到读之前。这正好够用，因为 volatile 写相当于释放锁，读相当于获取锁。

不保证原子性的原因很直接：i++ 是读、加一、写三步，两个线程可能同时读到旧值，各自加一后写回，结果少加一次。要原子就得用 AtomicInteger 的 CAS 或者直接加锁。

经典用法是双重检查锁里的实例字段，不加 volatile 的话，构造还没执行完引用就可能被其他线程看到半成品对象。状态标志位、一次性发布对象也常用它。

要注意它只保证单个变量的可见性。多个变量之间的一致性、复合操作，还是得靠锁或者原子类。另外 volatile 读写会禁止重排序，高频场景下比普通变量慢，别滥用。`,
    points: ["可见性和有序性，不含原子性", "内存屏障禁止重排序", "i++ 三步操作改用 CAS"],
    follow: "双重检查锁为什么要给实例字段加 volatile？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "backend-concurrent-synchronized-vs-lock",
    category: "backend",
    topic: "并发",
    difficulty: 2,
    tags: ["并发", "synchronized", "ReentrantLock", "锁升级"],
    question: "synchronized 和 ReentrantLock 有什么区别？",
    answer: `两者都是可重入的互斥锁，差别在实现和功能两个维度。

实现上，synchronized 是 JVM 关键字，靠对象头 Mark Word 加 monitor 实现。JDK 6 之后有无锁、偏向锁、轻量级锁、重量级锁的升级过程，大部分场景不用升级到重量级就解决了。ReentrantLock 是 JDK 层的，基于 AQS，用 CAS 修改 state，纯 Java 代码实现。

功能上 ReentrantLock 多出四样东西：

- 公平锁，构造函数传 true，按等待顺序获取。
- 可中断获取，lockInterruptibly 能在等待中被中断。
- 超时获取，tryLock 带时间参数，拿不到就放弃，避免死锁。
- 多个 Condition，能精确唤醒某一类等待线程，synchronized 只有一个等待队列。

释放方式差别最大：synchronized 由 JVM 自动释放，抛异常也会释放；ReentrantLock 必须写在 finally 里 unlock，漏了就是永久死锁。

性能上 JDK 6 优化之后两者差距很小，官方建议优先用 synchronized，代码简单不容易错。只有需要上面那四个能力时才用 Lock，比如实现有界阻塞队列、按条件分组唤醒。`,
    points: ["JVM 关键字与 AQS 实现差异", "公平锁、可中断、超时、Condition", "必须 finally 中解锁"],
    follow: "synchronized 的锁升级过程是怎样的？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-concurrent-ahas",
    category: "backend",
    topic: "并发",
    difficulty: 3,
    tags: ["并发", "AQS", "CLH 队列", "Condition"],
    question: "AQS 的原理是什么？它怎么支撑起各种同步器？",
    answer: `AQS 的核心是一个 volatile 的 int 型 state 加一条 CLH 变体的双向 FIFO 等待队列。

获取锁时先用 CAS 抢 state，失败就把当前线程包装成 Node 挂到队尾，然后 LockSupport.park 阻塞；释放时改 state 并唤醒后继节点，被唤醒的线程重新竞争。

它把「怎么判断能不能拿锁」交给子类，自己只管排队和阻塞唤醒。子类实现 tryAcquire、tryRelease 这类模板方法，独占还是共享由 acquire、release 与 acquireShared、releaseShared 决定。

不同同步器只是对 state 的解释不同：

- ReentrantLock 用 state 记重入次数，加一次加一，减到零才释放。
- Semaphore 用 state 表示剩余许可数。
- CountDownLatch 用 state 表示还没完成的计数。
- ReentrantReadWriteLock 把 state 高 16 位当读锁计数、低 16 位当写锁计数。

默认是非公平的，公平模式靠 hasQueuedPredecessors 判断队列里有没有前驱。Condition 则另外维护一条条件队列，await 时释放锁并转移节点。

实践上要知道它在大竞争下自旋加 park 的开销比无锁结构大，能用 LongAdder、ConcurrentHashMap 这类专用结构就别自己造锁。`,
    points: ["state 加 CLH 双向队列", "模板方法 tryAcquire 与 tryRelease", "各同步器对 state 的语义"],
    follow: "为什么 AQS 默认实现是非公平的？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-concurrent-threadpool-params",
    category: "backend",
    topic: "并发",
    difficulty: 1,
    tags: ["并发", "线程池", "ThreadPoolExecutor", "拒绝策略"],
    question: "线程池的核心参数有哪些？任务提交后怎么流转？",
    answer: `七个参数：corePoolSize、maximumPoolSize、keepAliveTime、unit、workQueue、threadFactory、handler。

提交流程分四步：当前线程数小于核心数就新建核心线程执行；否则尝试入队；队列满了且线程数小于最大线程数就新建非核心线程；再满就交给拒绝策略。

队列类型直接决定行为，这是最容易配错的地方：

- 用无界的 LinkedBlockingQueue，maximumPoolSize 形同虚设，任务会一直堆积到 OOM。
- 用 SynchronousQueue 不存任务，请求直接触发扩容到最大线程数。
- 用有界 ArrayBlockingQueue 才是标准用法，容量按峰值 QPS 乘可接受等待时间估算。

四种拒绝策略：AbortPolicy 抛异常，是默认值；CallerRunsPolicy 让提交任务的线程自己跑，天然形成背压；DiscardPolicy 静默丢弃；DiscardOldestPolicy 丢掉队首最老的。

非核心线程空闲超过 keepAliveTime 会被回收，打开 allowCoreThreadTimeOut 后核心线程也能回收。生产上必须用有界队列、自定义 threadFactory 起有意义的线程名、给拒绝策略加日志和告警，否则出问题连是哪个池都认不出来。线程数按任务类型定：CPU 密集型取核数加一，IO 密集型取核数乘二再按实际压测调。`,
    points: ["七个核心参数说全", "核心线程、队列、最大线程的流转", "四种拒绝策略与有界队列"],
    follow: "线程池的线程数怎么定？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-concurrent-threadlocal",
    category: "backend",
    topic: "并发",
    difficulty: 2,
    tags: ["并发", "ThreadLocal", "内存泄漏", "弱引用"],
    question: "ThreadLocal 的原理是什么？为什么会内存泄漏？",
    answer: `每个 Thread 内部有一个 ThreadLocalMap 字段，key 是 ThreadLocal 对象本身的弱引用，value 是强引用。读写时拿当前线程的 Map，再以 ThreadLocal 为 key 存取，所以数据天然隔离，不需要同步。

用弱引用是为了让 ThreadLocal 对象在外部没有强引用时能被回收，否则 Map 会一直拽着它。

泄漏的根源在 value 上：线程长期存活时，比如线程池里的核心线程，ThreadLocal 被回收后 Entry 的 key 变成 null，但 value 还被 Map 强引用着。这条 Entry 已经无法通过正常读写访问到，只能在后续 get、set 触发清理时顺带清掉一部分，如果线程一直不再访问这个 Map，value 就永远留着。

正确写法是用 try-finally 包住，业务逻辑放在 try 里，remove 放在 finally 里，保证抛异常也能清理掉。线程池场景尤其重要，因为线程会被复用，不 remove 就等于把上一个请求的上下文带给了下一个请求，可能造成越权或者数据串号。

另外父子线程传递用 InheritableThreadLocal，但线程池里线程是复用的，创建时机和任务提交时机对不上，传参会错乱，这种场景要用 TransmittableThreadLocal 做任务包装。链路追踪的 traceId、用户上下文、分页参数都是它的典型用途，也是最容易漏 remove 的地方。`,
    points: ["Thread 持有 ThreadLocalMap", "弱引用 key 与强引用 value 错配", "用完必须 remove"],
    follow: "线程池里怎么让父子线程传递上下文？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "CS-Notes", path: "docs/" }],
  },

  {
    id: "backend-collection-hashmap-resize",
    category: "backend",
    topic: "集合",
    difficulty: 2,
    tags: ["集合", "HashMap", "扩容", "红黑树"],
    question: "HashMap 的扩容机制是怎样的？容量为什么是 2 的幂？",
    answer: `默认容量 16，负载因子 0.75，阈值等于容量乘负载因子。元素个数超过阈值就扩容为两倍，然后把老数组的元素迁到新数组。

JDK 8 的迁移不需要重新算 hash。因为容量是 2 的幂，元素的新位置只有两种可能：还在原下标，或者原下标加旧容量。判断依据是 hash 值与旧容量做与运算的结果是 0 还是 1，于是每条链表被拆成低位和高位两条，相对顺序保持不变。JDK 7 用头插法，并发扩容时可能把链表接成环，之后 get 到这个桶就死循环、CPU 打满，这是最经典的线上事故。

容量取 2 的幂是为了把取模换成位运算：下标等于 hash 与容量减一做与运算，比取余快得多。代价是要求 hash 足够散，所以 JDK 8 的 hash 方法把高 16 位异或到低 16 位，让高位也参与运算。

树化条件有两个：链表长度达到 8 且数组长度达到 64，否则优先扩容而不是转树；退化阈值是 6，中间留一段缓冲避免反复转换。已知数据量时用带初始容量的构造函数，能省掉多次扩容和数组复制。`,
    points: ["负载因子 0.75 与两倍扩容", "高低位拆分避免重算 hash", "树化 8 与退化 6 的阈值"],
    follow: "JDK 7 的 HashMap 并发扩容为什么会死循环？",
    sources: [{ repo: "JavaGuide", path: "docs/java/collection/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-collection-concurrenthashmap",
    category: "backend",
    topic: "集合",
    difficulty: 2,
    tags: ["集合", "ConcurrentHashMap", "CAS", "分段锁"],
    question: "ConcurrentHashMap 怎么保证线程安全？JDK 7 和 8 有什么不同？",
    answer: `JDK 7 用分段锁：一个 Segment 数组，每个 Segment 继承 ReentrantLock，默认并发度 16，锁的粒度是一段，不同段可以并行写。

JDK 8 放弃了分段锁，改成 CAS 加 synchronized 的细粒度方案：

- 数组元素用 volatile 修饰保证可见性。
- 桶为空时用 CAS 直接插入，不加锁。
- 桶里已有节点就 synchronized 锁住该桶的头节点，粒度细到一个数组下标。

扩容支持多线程协同：迁移过的桶放一个 ForwardingNode 标记，其他线程遇到就加入一起搬，每个线程按步长认领一段区间，搬完再一起提交。

size 统计用 baseCount 加一个 CounterCell 数组分散热点，思路和 LongAdder 一样，所以 size 是近似值不是精确值，并发下只能当参考。

不允许 null 键值的原因是并发下 get 返回 null 无法区分「没有这个键」和「值就是 null」，调用方没法判断要不要加锁重查。

读操作基本无锁，靠 volatile 和节点的 val、next 指针保证读到的是完整节点。用它做本地缓存时要记得没有过期机制，得自己配 Caffeine 或者定时清理。`,
    points: ["7 分段锁，8 的 CAS 加 synchronized", "扩容时多线程协同迁移", "不允许 null 键值的原因"],
    follow: "ConcurrentHashMap 的 size 是怎么统计的？",
    sources: [{ repo: "JavaGuide", path: "docs/java/collection/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "backend-collection-arraylist-vs-linkedlist",
    category: "backend",
    topic: "集合",
    difficulty: 1,
    tags: ["集合", "ArrayList", "LinkedList", "扩容"],
    question: "ArrayList 和 LinkedList 怎么选？ArrayList 扩容代价多大？",
    answer: `ArrayList 底层是 Object 数组，支持随机访问，按下标取是 O(1)；LinkedList 是双向链表，头尾增删是 O(1)，但按下标访问要遍历，是 O(n)，而且每个节点多两个指针的内存开销，内存不连续导致 CPU 缓存命中率也差。

实践里绝大多数场景选 ArrayList。尾部追加是均摊 O(1)，就算中间插入，只要数据量不大，连续内存的数组复制比链表遍历还快。LinkedList 真正合适的场景很少，基本只有把它当队列或双端队列用时才考虑，而那种场景 ArrayDeque 通常更好。

扩容细节：默认容量 10，但注意是第一次 add 时才分配成 10，无参构造出来的是空数组。扩容是原容量的 1.5 倍，用右移一位实现，然后整体复制。频繁扩容的代价是内存翻倍峰值加一次全量复制，所以已知数据量时用带初始容量的构造函数，这是最常见的优化点。

还有一个高频坑：在 for 循环里按条件 remove 元素，下标会前移导致漏删，正确做法是倒着遍历，或者用 Iterator 的 remove，后者会同步修改 modCount 不会抛并发修改异常。`,
    points: ["数组与链表的结构差异", "默认容量 10 与 1.5 倍扩容", "预知容量时指定初始大小"],
    follow: "循环里删除 ArrayList 元素要注意什么？",
    sources: [{ repo: "JavaGuide", path: "docs/java/collection/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-collection-hashmap-thread-unsafe",
    category: "backend",
    topic: "集合",
    difficulty: 2,
    tags: ["集合", "HashMap", "线程安全", "fail-fast"],
    question: "HashMap 为什么线程不安全？多线程下会出什么问题？",
    answer: `三个层面的问题。

一是数据覆盖。两个线程同时往同一个空桶 put，都判断该位置为空然后各自写入，后写的把先写的覆盖掉，元素就丢了。size 是普通 int，并发自增会少算，进而导致扩容时机判断错误。

二是 JDK 7 的环形链表。头插法配合并发扩容，两个线程同时迁移同一条链表，可能互相指向对方形成环，之后 get 到这个桶就无限循环，CPU 直接打满，这是最出名的线上事故。JDK 8 改成尾插加高低位拆分，环的问题没有了，但丢数据依然存在。

三是 fail-fast。迭代过程中结构被修改会抛 ConcurrentModificationException，靠 modCount 与迭代器里的 expectedModCount 比对实现。它只是尽早暴露问题，不是线程安全保证，也不保证一定能检测到。

并发场景用 ConcurrentHashMap。Collections.synchronizedMap 也能用，但它是全局一把锁包住所有方法，连读都互斥，性能差一个量级，只有并发度极低时才考虑。另外用 HashMap 做本地缓存时要注意它没有过期和容量上限，长期运行会一直涨。`,
    points: ["并发 put 的数据覆盖与 size 少算", "JDK 7 头插法形成环形链表", "fail-fast 靠 modCount 比对"],
    follow: "Collections.synchronizedMap 和 ConcurrentHashMap 差在哪？",
    sources: [{ repo: "JavaGuide", path: "docs/java/collection/" }, { repo: "CS-Notes", path: "docs/" }],
  },

  {
    id: "backend-mysql-index-bplus-tree",
    category: "backend",
    topic: "MySQL",
    difficulty: 2,
    tags: ["MySQL", "索引", "B+ 树", "InnoDB"],
    question: "为什么 MySQL 索引用 B+ 树，而不是 B 树或红黑树？",
    answer: `核心是磁盘 IO 次数和范围查询效率。

B+ 树的非叶子节点只存索引键不存数据，所以一个 16KB 的页能塞下更多键，树的扇出更大、层数更低。按主键 bigint 8 字节加 6 字节页指针估算，一个页能放约 1170 个键，三层就能覆盖两千万行左右，查任意一行最多三次 IO。B 树的非叶子节点也存数据，扇出小，树更高，IO 更多。

红黑树是二叉的，高度是 log2 级别，两千万行要二十多层，每层一次随机 IO，磁盘场景下完全不可接受。它适合内存里的结构，比如 HashMap 的桶。

B+ 树还有个关键优势：叶子节点之间用双向链表串起来，范围查询和 order by 只要顺着链表顺序扫。B 树得反复中序遍历回溯，随机 IO 多得多。

InnoDB 里聚簇索引的叶子存整行数据，二级索引的叶子存主键值。所以走二级索引查非索引列要回表，先查到主键再回聚簇索引取整行。能覆盖查询列时就不用回表，也就是覆盖索引，explain 的 Extra 会显示 Using index。`,
    points: ["非叶子只存键，扇出大层数低", "叶子链表支撑范围查询", "聚簇索引与二级索引回表"],
    follow: "什么是覆盖索引？它怎么避免回表？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-mysql-index-leftmost",
    category: "backend",
    topic: "MySQL",
    difficulty: 1,
    tags: ["MySQL", "联合索引", "最左前缀", "索引失效"],
    question: "联合索引的最左前缀原则是什么？哪些情况会失效？",
    answer: `联合索引按定义时的列顺序逐列排序，只有从最左列开始连续匹配才能用上索引。

建了 a、b、c 三列索引：条件带 a 和 b 能走；只带 b 和 c 走不了；带 a 和 c 时 a 能用上但 c 用不上，只能靠 a 过滤后回表再筛 c。

范围查询会截断后面的列。a 用等值、b 用范围时，c 在索引里就用不上了。不过 MySQL 5.6 之后的索引下推能在存储引擎层先用 c 过滤再回表，减少回表次数，explain 的 Extra 会显示 Using index condition。

常见失效场景：

- 索引列上做函数或运算，比如对日期列套 date 函数，改成范围条件就能走索引。
- 隐式类型转换，字符串列传数字，或者字符集不一致的 join。
- 前导模糊，like 百分号开头。
- or 连接了没索引的列，整条语句退化成全表扫。
- 不等于、not in、is not null 有时会让优化器判断全表扫更便宜。

\`\`\`sql
-- 走索引
select id, name from orders where user_id = 100 and status = 1;
-- 不走索引：索引列上套了函数
select id from orders where date(created_at) = '2024-05-01';
\`\`\`

最终判断依据是 explain 的 key、rows 和 filtered，不要凭感觉。`,
    points: ["按定义顺序连续匹配才能用", "范围查询截断后续列", "函数、类型转换、前导模糊失效"],
    follow: "索引下推解决了什么问题？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-mysql-transaction-isolation",
    category: "backend",
    topic: "MySQL",
    difficulty: 1,
    tags: ["MySQL", "事务", "隔离级别", "幻读"],
    question: "MySQL 的四个隔离级别分别解决了什么问题？",
    answer: `从低到高是读未提交、读已提交、可重复读、串行化，解决的问题逐级递进。

- 读未提交：能读到别人没提交的数据，会脏读。
- 读已提交：只读已提交的数据，解决脏读，但同一事务内两次读同一行结果可能不同，也就是不可重复读。
- 可重复读：整个事务用同一个快照，解决不可重复读，标准里还剩幻读，即两次范围查询行数变了。
- 串行化：读加共享锁、写加排他锁，全串行，没有并发问题但性能最差。

InnoDB 默认是可重复读，而且靠 MVCC 加间隙锁在快照读下基本消除了幻读，行为和 SQL 标准不完全一致。当前读比如 select 加 for update 走的是锁，不是快照。

隔离级别还会影响 binlog 格式：读已提交下必须用 row 格式，否则主从可能不一致；可重复读下用 statement 一般也安全。

生产上不少互联网公司会主动改成读已提交，原因是它没有间隙锁，锁冲突少、并发插入性能好，代价是要接受不可重复读，业务上靠代码保证。改的时候记得同步把 binlog 格式设成 row。`,
    points: ["脏读、不可重复读、幻读的对应关系", "InnoDB 默认可重复读", "MVCC 加间隙锁处理幻读"],
    follow: "为什么很多公司把隔离级别改成读已提交？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "backend-mysql-mvcc",
    category: "backend",
    topic: "MySQL",
    difficulty: 3,
    tags: ["MySQL", "MVCC", "ReadView", "undo log"],
    question: "MVCC 是怎么实现的？ReadView 里包含什么？",
    answer: `MVCC 靠三样东西：隐藏字段、undo log 版本链、ReadView。

InnoDB 每行有两个隐藏字段：DB_TRX_ID 记录最后修改它的事务 id，DB_ROLL_PTR 指向 undo log 里的上一个版本。每次修改都把旧值写进 undo log，多个版本串成一条链表，这是快照读能读到历史版本的基础。

ReadView 是快照读时生成的可见性判断依据，包含四部分：

- 生成这一刻所有活跃但未提交的事务 id 列表。
- 列表里最小的事务 id，记为低水位。
- 下一个将要分配的事务 id，记为高水位。
- 创建这个 ReadView 的事务自己的 id。

判断规则：行的 trx_id 小于低水位说明早已提交，可见；大于等于高水位说明是之后才开启的事务，不可见；落在中间就看它在不在活跃列表里，在就不可见。不可见就顺着回滚指针找上一个版本重新判断，直到找到可见版本或者链表走完。

读已提交和可重复读的差别就在生成时机：读已提交每次 select 都重新生成 ReadView，所以能看到别人新提交的数据；可重复读只在第一次 select 时生成，整个事务复用，所以两次读结果一致。当前读会绕过 MVCC 直接加锁读最新版本。`,
    points: ["隐藏字段与 undo log 版本链", "ReadView 的四个组成部分", "两种级别生成时机不同"],
    follow: "当前读和快照读有什么区别？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-mysql-lock-gap",
    category: "backend",
    topic: "MySQL",
    difficulty: 3,
    tags: ["MySQL", "锁", "间隙锁", "死锁"],
    question: "InnoDB 的行锁有哪几种？间隙锁是干什么的？",
    answer: `按粒度分三种：记录锁锁住单条索引记录；间隙锁锁住两条记录之间的开区间；临键锁是记录锁加前面的间隙，是可重复读下的默认加锁单位。

间隙锁的目的只有一个：阻止其他事务在区间内插入新记录，从而避免幻读。它锁的是间隙不是记录，所以两个事务可以对同一个间隙同时持有间隙锁，互不冲突，这也是间隙锁之间不会阻塞但插入会阻塞的原因。

它只在可重复读级别存在，读已提交没有间隙锁，所以改成读已提交能显著减少锁冲突。

加锁行为跟索引强相关，这是线上最容易踩的坑：查询条件没走索引时会退化成锁全表所有记录和间隙，一条没走索引的 update 就能把整张表锁死。唯一索引上的等值查询命中记录时只加记录锁，不加间隙；没命中才会加间隙锁。

死锁排查用 show engine innodb status，看 LATEST DETECTED DEADLOCK 段，里面有两个事务正在执行的 SQL、各自持有的锁和等待的锁。常见成因是加锁顺序不一致、间隙锁互相等待、或者一个事务里更新多张表顺序不统一。

业务上统一按主键升序更新、把大事务拆小、缩短事务持有锁的时间，能规避掉大部分死锁。`,
    points: ["记录锁、间隙锁、临键锁", "间隙锁防止插入避免幻读", "没走索引会锁全表"],
    follow: "线上遇到死锁你怎么排查？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-mysql-sharding",
    category: "backend",
    topic: "MySQL",
    difficulty: 3,
    tags: ["MySQL", "分库分表", "分片键", "ShardingSphere"],
    question: "什么时候需要分库分表？分片键怎么选？",
    answer: `先明确它是最后手段。单表超过两千万行、单库磁盘或连接数到瓶颈时才考虑，之前该做的是加索引、加缓存、读写分离、冷数据归档。分库分表一旦上了，分布式事务、跨库 join、全局排序、扩容迁移这些问题会跟着来，改造成本远大于前面几项。

分片键的选择标准是三条：查询尽量能带上它，避免全路由；数据要均匀，防止热点；尽量少跨片。

订单类业务常见两种做法：

- 按 user_id 哈希取模，同一用户的订单落在同一片，按用户查最顺，但按订单号查就得靠映射表或者基因法，把 user_id 的低几位拼进订单号里，这样订单号自己就带了分片信息。
- 按 order_id 取模，写入均匀，但用户维度查询要扫全部分片。

按时间分表适合日志和流水，要注意新表写入集中形成热点，旧表冷清，最好再按 hash 二次打散。

扩容时取模分片最麻烦，一般用两倍扩容加双写迁移加数据校验，或者一开始就用一致性哈希、雪花 ID 里预留分片位。另外分片后自增主键会冲突，得换成分布式 ID 方案。`,
    points: ["先优化索引缓存再谈分片", "分片键要均匀且尽量带在查询里", "扩容迁移与跨片查询的代价"],
    follow: "分片之后怎么做全局唯一 ID 和分页？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },

  {
    id: "backend-redis-data-structures",
    category: "backend",
    topic: "Redis",
    difficulty: 1,
    tags: ["Redis", "数据结构", "跳表", "listpack"],
    question: "Redis 有哪些常用数据结构？底层分别是什么？",
    answer: `对外有五种基本类型：String、Hash、List、Set、ZSet，还有 Bitmap、HyperLogLog、Geo、Stream 这些扩展类型。

底层编码按数据规模自动切换：

- String 用 SDS 简单动态字符串，自身记录长度所以取长度是 O(1)，且二进制安全，能存图片字节。
- Hash 在字段少且值小时用 listpack，超过阈值转哈希表，阈值由 hash-max-listpack-entries 默认 128 和 hash-max-listpack-value 默认 64 控制。
- List 在 3.2 之后统一用 quicklist，本质是双向链表串起多个 listpack，兼顾内存和操作效率。
- Set 全是整数且数量少时用 intset，否则用哈希表。
- ZSet 元素少时用 listpack，超过 zset-max-listpack-entries 默认 128 后转跳表加字典的组合。

ZSet 为什么用跳表不用红黑树：跳表实现简单、范围查询只要顺着底层链表走、插入删除只需改局部指针，而且容易做并发控制。字典负责按成员查分值，跳表负责按分值排序和范围查，两者配合让两种查询都是 O(logN) 或 O(1)。

选型时要注意小数据量下 listpack 是线性操作，几万个字段的 Hash 做 hgetall 会明显变慢，得提前拆。`,
    points: ["五种基本类型与扩展类型", "listpack、intset、quicklist 的阈值", "ZSet 用跳表加字典的原因"],
    follow: "跳表和红黑树比有什么优势？",
    sources: [{ repo: "JavaGuide", path: "docs/database/redis/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-redis-persistence",
    category: "backend",
    topic: "Redis",
    difficulty: 1,
    tags: ["Redis", "持久化", "RDB", "AOF"],
    question: "RDB 和 AOF 的区别是什么？线上怎么配？",
    answer: `RDB 是某一时刻的全量二进制快照，文件紧凑、恢复快、适合备份和主从全量同步，缺点是会丢最后一次快照之后的数据。触发方式有三种：save 命令阻塞主线程、bgsave 用 fork 出子进程、以及配置里的自动触发规则比如 900 秒内至少 1 次修改。

AOF 是追加写的命令日志，先写 aof_buf 缓冲，再按 appendfsync 策略刷盘：

- always：每条命令都 fsync，最安全但性能最差，QPS 会掉一个量级。
- everysec：每秒刷一次，是默认值，最多丢一秒数据，兼顾安全和性能。
- no：交给操作系统决定，通常 30 秒左右刷一次，宕机丢得多。

AOF 文件会持续膨胀，靠重写压缩，重写时 fork 子进程把当前数据写成最小命令集，期间的新写入记在重写缓冲区，写完再追加。Redis 4.0 之后支持混合持久化，重写后的文件前半段是 RDB 格式、后半段是增量 AOF，兼顾恢复速度和数据完整度。

生产建议两个都开：从库开 AOF 保数据安全，主库开 RDB 做备份和快速恢复。要特别注意 fork 的写时复制会额外占用内存，大实例 fork 可能卡顿几百毫秒，内存最好留一半余量，并避开业务高峰做重写。`,
    points: ["快照与命令日志的本质差异", "appendfsync 三种策略的取舍", "混合持久化与 fork 写时复制开销"],
    follow: "AOF 重写期间的新写入怎么处理？",
    sources: [{ repo: "JavaGuide", path: "docs/database/redis/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-redis-cache-problems",
    category: "backend",
    topic: "Redis",
    difficulty: 2,
    tags: ["Redis", "缓存穿透", "缓存击穿", "缓存雪崩"],
    question: "缓存穿透、击穿、雪崩分别是什么？怎么防？",
    answer: `三个问题的表现都是请求压到数据库，但成因完全不同，防法也不同。

穿透是查的数据根本不存在，缓存永远不命中，每次都查库，恶意攻击常用不存在的 id 刷。防法一是缓存空值并设一个较短的过期时间，比如 60 秒，实现简单；二是用布隆过滤器在入口挡掉，它用位数组加多个哈希函数，判断不存在一定准确、判断存在有误判率，且标准布隆不能删元素，要删得用计数布隆或者定期重建。

击穿是某个热点 key 过期瞬间，大量并发请求同时回源。防法是热点数据干脆不设过期、靠后台任务更新，或者逻辑过期加异步刷新；也可以用互斥锁只放一个线程回源，其他线程短暂等待后重试，注意锁要设超时防止死锁。

雪崩是大量 key 同时过期，或者 Redis 整体故障。防法是在基础过期时间上加随机偏移打散，做本地缓存加 Redis 的多级缓存，集群做哨兵或 Cluster 高可用，并且给数据库入口加限流和降级兜底。

热 key 本身也要单独治理：单分片 CPU 打满时可以把 key 拆成多份分散读，或者把热点数据放本地缓存，用短过期加消息通知来保证一致性。`,
    points: ["三者成因与表现要分清", "空值缓存与布隆过滤器防穿透", "随机过期与互斥回源防击穿雪崩"],
    follow: "布隆过滤器为什么不能删除元素？",
    sources: [{ repo: "JavaGuide", path: "docs/database/redis/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "backend-redis-distributed-lock",
    category: "backend",
    topic: "Redis",
    difficulty: 3,
    tags: ["Redis", "分布式锁", "Redlock", "Lua"],
    question: "用 Redis 做分布式锁要注意什么？",
    answer: `加锁必须一条命令完成：set key value nx px 过期毫秒数。不要用 setnx 再加 expire 两条命令，中间宕机就永久死锁了。

value 要放唯一标识，比如 UUID 拼线程 id。解锁时先比对 value 再删除，而且比对和删除要写在 Lua 脚本里原子执行。否则可能出现：线程 A 比对通过后锁刚好过期、线程 B 拿到锁，A 接着执行删除，把 B 的锁删了。

过期时间要大于业务执行时间，但很难准确预估，所以要有续期机制。Redisson 的看门狗默认每 10 秒续一次，续到 30 秒，而且只在没显式指定过期时间时才启用；显式指定了 leaseTime 就没有看门狗，得自己保证业务能在过期前跑完。

主从架构下还有一致性漏洞：主节点加锁成功但还没同步到从库就宕机，从库升主后其他线程也能加锁成功。Redlock 想解决这个，要求向多数节点加锁并统计耗时，但它依赖各节点时钟大致同步，GC 停顿或时钟跳变都可能破坏正确性，学术界和工业界争议都很大。

对一致性要求高的场景，比如资金扣减，应该用 ZooKeeper 或 etcd 的临时顺序节点方案，靠会话和租约保证，代价是性能低一些、要额外维护一套组件。`,
    points: ["set 带 nx 和 px 一条命令加锁", "唯一 value 加 Lua 原子解锁", "看门狗续期与主从切换漏洞"],
    follow: "Redlock 为什么有争议？",
    sources: [
      { repo: "JavaGuide", path: "docs/distributed-system/distributed-lock.md" },
      { repo: "JavaGuide", path: "docs/distributed-system/distributed-lock-implementations.md" },
    ],
  },
  {
    id: "backend-redis-bigkey-hotkey",
    category: "backend",
    topic: "Redis",
    difficulty: 3,
    tags: ["Redis", "大 key", "热 key", "内存排查"],
    question: "Redis 大 key 有什么危害？怎么排查和治理？",
    answer: `大 key 一般指单个 value 过大，经验阈值是 String 超过 10KB，或者集合类元素超过 5000 个。

危害有四个。一是 Redis 命令执行是单线程的，一次 hgetall 几十万字段、或者 smembers 一个大 Set，会阻塞主线程，后面所有请求排队，表现为毛刺甚至超时雪崩。二是删除大 key 时 del 是同步释放内存，几十万元素能卡住几百毫秒，必须换成 unlink 异步删除。三是集群模式下数据倾斜，某个分片内存和流量远高于其他节点，扩容也解决不了。四是主从复制、持久化、以及集群迁移时产生巨大的网络和磁盘开销。

排查方式：

\`\`\`bash
redis-cli --bigkeys
redis-cli --memkeys
redis-cli memory usage somekey
\`\`\`

bigkeys 用 scan 采样统计各类型最大的 key，不会阻塞，适合线上；更精确的可以分析 RDB 文件。绝对不要用 keys 命令扫。

治理思路是拆分：大 Hash 按字段哈希拆成多个 key，大 List 按时间或范围切段，大 Set 按业务维度分桶，大 String 考虑压缩或者换存储介质。写入侧加长度校验和监控，超过阈值就告警，比事后拆分省事得多。`,
    points: ["阻塞主线程与集群数据倾斜", "bigkeys 扫描与 unlink 异步删除", "按字段或范围拆分大 key"],
    follow: "热 key 怎么发现和处理？",
    sources: [{ repo: "JavaGuide", path: "docs/database/redis/" }, { repo: "athena", path: "doc/" }],
  },

  {
    id: "backend-spring-ioc-aop",
    category: "backend",
    topic: "Spring",
    difficulty: 1,
    tags: ["Spring", "IoC", "AOP", "动态代理"],
    question: "Spring 的 IoC 和 AOP 分别解决了什么问题？",
    answer: `IoC 控制反转是把对象的创建和依赖装配交给容器。你只声明需要什么，容器在启动时创建 Bean 并注入依赖，好处是解耦、方便替换实现、便于测试时注入 mock。依赖注入是它的实现手段，有构造器注入、setter 注入、字段注入三种，官方推荐构造器注入，因为能保证依赖不为空、字段可以声明为 final、循环依赖也会在启动时直接暴露而不是运行期空指针。

AOP 面向切面是把日志、事务、权限、缓存这些横切逻辑从业务代码里抽出来，通过动态代理在方法调用前后织入，业务方法只关心业务。

代理方式有两种：目标类实现了接口时默认用 JDK 动态代理，基于接口生成代理类；没有接口时用 CGLIB 生成子类。Spring Boot 2.x 之后默认统一用 CGLIB，可以通过 proxy-target-class 配置改回去。CGLIB 的代价是没法代理 final 类和 final 方法。

要牢记代理的边界：同类内部方法直接调用不走代理对象，所以事务、缓存、自定义注解全都会失效，这是最高频的踩坑点。另外代理会让方法栈变深，排查性能问题时留意一下。`,
    points: ["控制反转与依赖注入的关系", "JDK 动态代理与 CGLIB 的选择", "自调用不走代理导致注解失效"],
    follow: "为什么官方推荐构造器注入？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/framework/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-spring-bean-lifecycle",
    category: "backend",
    topic: "Spring",
    difficulty: 2,
    tags: ["Spring", "Bean 生命周期", "BeanPostProcessor", "Aware"],
    question: "说说 Spring Bean 的生命周期。",
    answer: `大致四个阶段。

实例化：反射调用构造器创建对象，此时只是个空壳，字段都还没注入。

属性赋值：按依赖关系注入其他 Bean，这一步也是循环依赖能被解决的关键位置，Spring 会把早期引用提前暴露出去。

初始化：依次执行 Aware 接口回调，比如 BeanNameAware、BeanFactoryAware、ApplicationContextAware；然后 BeanPostProcessor 的 postProcessBeforeInitialization；再执行 PostConstruct 注解方法、InitializingBean 的 afterPropertiesSet、自定义 init-method；最后 postProcessAfterInitialization。AOP 代理就是在最后这一步生成的，所以注入到别处的其实是代理对象。

销毁：容器关闭时执行 PreDestroy、DisposableBean 的 destroy、自定义 destroy-method。

单例 Bean 在容器启动时就完成前三步并放进单例池，原型 Bean 每次获取都走完整流程，而且容器不负责它的销毁回调。

实际开发中最常扩展的两个点是 BeanFactoryPostProcessor 和 BeanPostProcessor：前者在 Bean 实例化之前修改 BeanDefinition，比如替换占位符；后者在实例化之后加工 Bean 实例，比如生成代理、注入自定义属性。理解这个顺序，很多「注入的 Bean 为什么是代理」的问题就自然清楚了。`,
    points: ["实例化、属性赋值、初始化、销毁", "Aware 回调与 BeanPostProcessor", "AOP 代理在初始化后生成"],
    follow: "BeanFactoryPostProcessor 和 BeanPostProcessor 有什么区别？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/framework/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-spring-circular-dependency",
    category: "backend",
    topic: "Spring",
    difficulty: 3,
    tags: ["Spring", "循环依赖", "三级缓存", "AOP"],
    question: "Spring 怎么解决循环依赖？为什么要三级缓存？",
    answer: `三级缓存是三个 Map：一级 singletonObjects 放完全初始化好的成品；二级 earlySingletonObjects 放还没注入属性的半成品；三级 singletonFactories 放能产出早期引用的对象工厂。

流程是：创建 A 时先实例化，把自己包装成工厂放进三级缓存，然后开始注入 B；创建 B 时要注入 A，从三级缓存拿到工厂，调用它得到 A 的早期引用，放进二级缓存并删掉三级缓存，B 完成创建；A 继续完成初始化，最后放进一级缓存。

为什么不是两级？关键在 AOP。如果 A 需要被代理，工厂里返回的是提前生成的代理对象，这样 B 注入的 A 和最终放进一级缓存的 A 是同一个对象。如果只有两级缓存，早期引用只能暴露原始对象，而最终一级缓存里是代理对象，两者不一致，B 里持有的就是个没被增强的裸对象，事务和切面全部失效。

它的局限要说清楚：只支持单例、且必须是 setter 或字段注入；构造器注入的循环依赖在实例化阶段就卡住了，直接抛 BeanCurrentlyInCreationException；原型 Bean 不支持。Spring Boot 2.6 之后默认禁止循环依赖，需要显式打开开关才能恢复旧行为。

根治办法是重构：用 ObjectProvider 延迟获取、加 Lazy 注解，或者抽第三个类打破环。循环依赖本身往往说明职责划分有问题。`,
    points: ["三级缓存各自的职责", "三级缓存是为了提前暴露代理", "构造器注入与原型 Bean 不支持"],
    follow: "Spring Boot 2.6 之后为什么默认禁止循环依赖？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/framework/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-spring-transaction-failure",
    category: "backend",
    topic: "Spring",
    difficulty: 2,
    tags: ["Spring", "事务", "事务失效", "传播行为"],
    question: "Spring 事务在哪些情况下会失效？",
    answer: `根本原因只有一个：事务靠 AOP 代理实现，任何绕过代理或者让拦截器不生效的调用都会失效。

典型场景：

- 同类内部方法直接调用，this 调用不走代理对象。解法是注入自己、用 AopContext.currentProxy 拿当前代理，或者把方法拆到另一个 Bean 里。
- 方法不是 public，事务拦截器默认只对 public 方法生效。
- 异常被自己 try-catch 吃掉没往外抛，拦截器感知不到失败。
- 抛的是检查异常，默认只对 RuntimeException 和 Error 回滚，要回滚得显式写 rollbackFor 等于 Exception。
- 表引擎不支持事务，比如 MyISAM。
- 传播行为配成了 NOT_SUPPORTED 或 REQUIRES_NEW 后又把异常吞了，前者压根不开事务，后者内层独立提交不受外层回滚影响。
- 对象是自己 new 出来的，没被 Spring 管理，自然没有代理。

排查顺序：先确认注入的是不是代理对象，再看方法可见性和自调用，然后看异常类型和传播行为，最后确认数据库引擎和存储层有没有参与同一个事务。

生产上建议统一在 service 层方法上标注回滚异常类型，并且避免在事务方法里做远程调用和耗时操作，否则连接被长时间占用，连接池很容易被打满。`,
    points: ["自调用绕过代理", "非 public 方法与异常被吞", "默认只回滚运行时异常"],
    follow: "事务的传播行为有哪些？REQUIRES_NEW 用在哪？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/framework/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-spring-boot-autoconfig",
    category: "backend",
    topic: "Spring",
    difficulty: 2,
    tags: ["Spring Boot", "自动装配", "条件注解", "SPI"],
    question: "Spring Boot 自动装配的原理是什么？",
    answer: `入口是启动类上的 EnableAutoConfiguration 注解，它通过 Import 导入 AutoConfigurationImportSelector。这个选择器去扫描所有 jar 包里 META-INF 目录下的 spring.factories 文件，取出 EnableAutoConfiguration 对应的配置类全限定名列表，批量注册成配置类。

Spring Boot 2.7 之后改成了 META-INF/spring 目录下的 AutoConfiguration.imports 文件，每行一个类名，3.0 彻底移除了 spring.factories 的自动配置方式。这个改动主要是为了解决 spring.factories 全量加载导致的启动慢和类加载开销。

这些配置类不会全部生效，上面挂着一堆条件注解做过滤：

- ConditionalOnClass：类路径里有指定类才生效，用于可选依赖。
- ConditionalOnMissingBean：容器里没有同类型 Bean 才生效，这条保证了用户自己的配置优先。
- ConditionalOnProperty：读配置文件里的开关。
- ConditionalOnWebApplication 等按应用类型判断。

生效顺序由 AutoConfigureOrder、AutoConfigureBefore、AutoConfigureAfter 控制，避免同类型 Bean 的注册顺序出错。

排查某个自动配置为什么没生效，启动时加上 debug 参数，会打印自动配置报告，分 Positive matches 和 Negative matches 两段，直接告诉你哪个条件没满足，比翻源码快得多。`,
    points: ["EnableAutoConfiguration 与 Import 选择器", "spring.factories 改为 imports 文件", "条件注解过滤与生效顺序"],
    follow: "怎么排查某个自动配置为什么没生效？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/framework/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },

  {
    id: "backend-mq-idempotent",
    category: "backend",
    topic: "消息队列",
    difficulty: 2,
    tags: ["消息队列", "幂等", "重复消费", "去重表"],
    question: "消息重复消费怎么保证幂等？",
    answer: `先接受一个前提：主流 MQ 只保证至少一次投递，重复不可避免，幂等必须由消费端自己做。

重复的来源有两处：生产端发送超时后重试，同一条消息被写进 broker 两次；消费端业务处理成功但 ack 丢失，broker 重新投递。

通用做法是用业务唯一键去重：

- 数据库唯一索引，用订单号或消息里的业务 id 建唯一索引，插入冲突就认为已处理，直接返回成功。简单可靠，但依赖同一个库。
- Redis 记录，用 set 命令带 nx 和过期时间，key 是业务 id。性能好，缺点是 Redis 故障时可能漏判。
- 状态机兜底，订单状态只能从待支付流转到已支付，重复消息第二次就被状态判断挡掉，这条最贴近业务本质。

最关键的一点是去重记录必须和业务操作在同一个本地事务里提交，否则去重记录写成功而业务失败，这条消息就永久丢了，比重复消费严重得多。

RocketMQ 的消息 id 只在单个 broker 内唯一，跨集群不保证，不能拿它当去重键。Kafka 开了幂等生产者只能解决生产端重试导致的重复，消费端的重复还得自己处理。`,
    points: ["至少一次投递决定重复不可避免", "唯一键加去重表或 Redis 记录", "去重与业务操作必须同事务"],
    follow: "RocketMQ 的事务消息是怎么实现的？",
    sources: [{ repo: "advanced-java", path: "docs/high-concurrency/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-mq-order",
    category: "backend",
    topic: "消息队列",
    difficulty: 2,
    tags: ["消息队列", "顺序消息", "分区", "RocketMQ"],
    question: "怎么保证消息的顺序性？",
    answer: `全局顺序的代价太高，等于单队列单线程，吞吐掉一个量级，所以实际只做局部顺序：同一个业务键的消息有序。

RocketMQ 靠 MessageQueue 保证：生产端用 MessageQueueSelector 按订单号取模选队列，保证同一订单进同一个队列；消费端用 MessageListenerOrderly，对队列加锁单线程消费。一个 Topic 的队列数决定最大并行度。

Kafka 对应的是 partition：生产时指定相同的 key 就会落到同一个分区，消费端每个分区只被一个消费者线程处理，同一分区内天然有序。

几个必须注意的坑：

- 生产端如果开了重试且没有幂等，重试消息可能后于新消息落盘，顺序就乱了，所以顺序消息要配合幂等一起做。
- 消费端不能为了提吞吐改成并发消费，也不能把消息丢进线程池异步处理，一异步顺序就没了。
- 队列数或分区数扩容会让同一个 key 的路由结果改变，扩容期间同一订单可能落到不同队列，要暂停发送或者双跑过渡。
- 消费失败重试会阻塞整个队列，顺序场景下重试次数和阻塞时长要设上限，避免一条坏消息卡死整条链路。

真需要严格全局有序时，只能单队列单线程，并且要评估业务是否真的需要。`,
    points: ["只做同一业务键的局部有序", "生产端按 key 选同一队列或分区", "消费端单线程且不能异步处理"],
    follow: "顺序消息怎么配合幂等一起做？",
    sources: [{ repo: "advanced-java", path: "docs/high-concurrency/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-mq-backlog",
    category: "backend",
    topic: "消息队列",
    difficulty: 2,
    tags: ["消息队列", "消息积压", "扩容", "降级"],
    question: "线上消息积压了几百万条，你怎么处理？",
    answer: `先定位原因，再决定动作。看消费延迟曲线和消费 TPS：是消费端变慢了，还是生产端突然放量。

消费端变慢的常见原因是下游接口超时、数据库慢 SQL、消费逻辑里做了重操作，或者消费者实例挂了、线程池被占满。

应急手段按顺序考虑：

- 加消费者实例。但实例数不能超过队列数或分区数，超过了也是空转，这时要先临时扩容队列再扩消费者。
- 积压特别严重时，起一个临时消费者把消息快速转存到一个新 Topic，新 Topic 分区数放大，再让一批消费者并行处理，处理完再缩容，这是标准的临时扩容思路。
- 判断消息时效性。过期的促销、通知类消息可以直接丢弃或转存归档，优先保住核心链路，别让几百万条废消息堵住正常业务。

还要注意消费端加限流，避免恢复瞬间把下游数据库打垮，形成二次雪崩。补数据时用批量和限速，别一次性全放。

事后必须补监控：堆积量、消费延迟、消费 TPS、消费失败率都要有告警阈值。消费逻辑要做成幂等，这样才能放心重跑。预防上给队列设容量上限和死信队列，消费端加熔断，下游抖动时快速失败而不是把线程全挂住。`,
    points: ["先定位是消费慢还是生产突增", "扩消费者前先扩队列或分区", "按消息时效性决定丢弃还是补跑"],
    follow: "怎么预防消息积压再次发生？",
    sources: [{ repo: "advanced-java", path: "docs/high-concurrency/" }, { repo: "CS-Notes", path: "docs/" }],
  },

  {
    id: "backend-distributed-cap-base",
    category: "backend",
    topic: "分布式",
    difficulty: 2,
    tags: ["分布式", "CAP", "BASE", "最终一致性"],
    question: "CAP 和 BASE 理论是什么？实际怎么取舍？",
    answer: `CAP 说一致性、可用性、分区容错性最多同时满足两个。分布式系统里网络分区是必然发生的，所以分区容错性其实是必选项，真正的选择是在一致性 C 和可用性 A 之间。

要注意这里的 C 是线性一致性，比数据库 ACID 里的 C 强得多，也不是最终一致性。很多人答错就错在把它理解成事务一致性。

选 CP 的典型是 ZooKeeper、etcd：选举期间少数派不可用，宁可拒绝服务也不返回旧数据。选 AP 的典型是 Eureka、Nacos 的临时实例：各节点独立提供服务，数据最终一致，可用性优先。

BASE 是对 AP 的延伸：基本可用、软状态、最终一致。意思是允许中间状态存在，靠补偿、重试、对账把数据拉齐。

实践中的判断依据是业务对不一致的容忍窗口有多长。下单扣库存、发优惠券这类走异步消息，接受秒级最终一致；资金流水、账户余额这类要么选 CP，要么用分布式事务框架做补偿，要么在业务上设计成单向操作加对账兜底。

面试时把「业务能接受多长的不一致窗口」说清楚，比背定义有价值得多。`,
    points: ["分区容错必选，在 C 和 A 之间选", "C 指线性一致性不是 ACID", "BASE 用最终一致换可用性"],
    follow: "最终一致性一般怎么落地？",
    sources: [{ repo: "advanced-java", path: "docs/distributed-system/" }, { repo: "JavaGuide", path: "docs/system-design/basis/" }],
  },
  {
    id: "backend-distributed-id",
    category: "backend",
    topic: "分布式",
    difficulty: 2,
    tags: ["分布式", "分布式 ID", "雪花算法", "时钟回拨"],
    question: "分布式 ID 有哪些方案？雪花算法的坑在哪？",
    answer: `常见四类方案：

- UUID：本地生成无依赖，但无序、占 36 个字符，做 MySQL 主键会导致页分裂和索引膨胀，只适合做链路追踪 id 这类不落库的场景。
- 数据库号段模式：一次从数据库取一批号缓存在内存里，比如每次取 1000 个，用完再取。性能高、趋势递增，美团 Leaf 就是这个思路，缺点是强依赖数据库可用性，DB 挂了发号会中断。
- Redis 自增：性能好，但每次多一次网络往返，且要考虑持久化，重启可能回退。
- 雪花算法：64 位组成是 1 位符号位、41 位毫秒时间戳可用约 69 年、10 位机器 id 支持 1024 个节点、12 位序列号每毫秒 4096 个。本地生成无网络开销，趋势递增，是主流选择。

雪花算法最大的坑是时钟回拨。NTP 校准或者运维改时间导致时钟往回调，就可能生成重复 id。

三种应对：回拨幅度小就自旋等待时间追上，比如几十毫秒内；幅度大就抛异常并告警，宁可拒绝服务也不能发重号；也可以在机器位里留几位做备用序列，回拨时用备用位顶一下。

另外容器环境下机器 id 不能写死在配置文件里，要用 Redis 或 ZooKeeper 动态分配并做心跳续约，否则 Pod 重建后很容易撞号。`,
    points: ["UUID、号段、Redis、雪花算法对比", "雪花算法的位分配", "时钟回拨的三种应对"],
    follow: "容器环境下机器 id 怎么分配？",
    sources: [{ repo: "JavaGuide", path: "docs/distributed-system/distributed-id.md" }, { repo: "advanced-java", path: "docs/distributed-system/" }],
  },
  {
    id: "backend-distributed-transaction",
    category: "backend",
    topic: "分布式",
    difficulty: 3,
    tags: ["分布式", "分布式事务", "Seata", "TCC"],
    question: "分布式事务有哪些方案？Seata 的几种模式怎么选？",
    answer: `按一致性强度从强到弱排：

- 两阶段提交：数据库层面的 XA 就是它，准备和提交两个阶段，强一致但全程持锁、阻塞严重、协调者单点，性能最差，只适合低频的强一致场景。
- TCC：业务层的两阶段，自己实现 try、confirm、cancel 三个方法。性能好、不依赖数据库锁，但侵入大，必须处理好三个问题：空回滚（try 没执行却收到 cancel）、幂等（confirm 和 cancel 可能重试）、悬挂（cancel 比 try 先到）。
- 本地消息表 / 事务消息：把消息和业务数据写在同一个本地事务里，再靠定时任务或 MQ 重试补投。实现简单、可靠，只能保证最终一致，适合大部分业务。
- 最大努力通知：通知方尽力重试，接收方自己对账兜底，一致性最弱，适合对账类场景。

Seata 的四种模式：AT 模式对业务无侵入，靠 undo log 记录数据前后镜像自动生成反向 SQL 回滚，用全局锁保证写隔离，适合绝大多数常规业务；TCC 模式适合要调外部接口、没有本地事务可用的场景；Saga 适合长流程，每步配一个补偿动作；XA 模式适合已经用了 XA 数据源的存量系统。

选型先问业务能接受多长的不一致窗口、允许多少人工介入。能用最终一致就别上强一致，运维和排查成本差一个量级。`,
    points: ["2PC、TCC、消息最终一致、最大努力通知", "TCC 的空回滚、幂等、悬挂", "AT 模式靠 undo log 自动回滚"],
    follow: "TCC 的空回滚是怎么产生的？",
    sources: [
      { repo: "JavaGuide", path: "docs/distributed-system/distributed-transaction.md" },
      { repo: "advanced-java", path: "docs/distributed-system/" },
    ],
  },
  {
    id: "backend-distributed-rate-limit",
    category: "backend",
    topic: "分布式",
    difficulty: 2,
    tags: ["分布式", "限流", "令牌桶", "Sentinel"],
    question: "限流算法有哪些？分布式下限流怎么做？",
    answer: `四种基础算法，各自解决不同问题：

- 固定窗口：最简单，但窗口切换的临界点上可能瞬间放过两倍流量，比如限制每秒 100，前 0.9 秒来 100 个、后 0.1 秒又来 100 个。
- 滑动窗口：把时间切成小格滚动统计，精度和内存的折中，Sentinel 用的就是它。
- 漏桶：以固定速率流出，能削峰，但放不下突发流量，桶满了直接拒绝。
- 令牌桶：按固定速率放令牌，桶里可以积累，允许一定程度的突发，是实践中最常用的。

单机限流用 Guava 的 RateLimiter 或者 Sentinel 单机模式就够了。集群限流要引入中心存储，用 Redis 加 Lua 脚本把计数和判断放在一次原子操作里完成，避免多次往返带来的竞态。

Redis 方案要注意两点：每次请求都要访问 Redis，延迟和 Redis 可用性成为新的依赖，可以用本地预取一批令牌的方式减少调用；key 一定要设过期时间，否则内存无限增长。

落地时按维度分别设阈值：网关层按 ip、用户、接口，应用层按核心方法，数据库层按连接数，多层叠加才是完整的防护。限流之外还要配熔断和降级，Sentinel 的流控效果里还有排队等待和预热冷启动两种模式，后者适合刚上线的服务。`,
    points: ["固定窗口、滑动窗口、漏桶、令牌桶", "Redis 加 Lua 做原子计数", "网关限流加应用层兜底"],
    follow: "限流和熔断、降级的区别是什么？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/basis/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },

  {
    id: "backend-network-tcp-handshake",
    category: "backend",
    topic: "网络",
    difficulty: 1,
    tags: ["网络", "TCP", "三次握手", "TIME_WAIT"],
    question: "TCP 为什么三次握手？四次挥手为什么多一次？",
    answer: `三次握手是为了双向确认收发能力，同时防止历史连接：客户端发 SYN 带自己的初始序号；服务端回 SYN 加 ACK，既确认收到又带上自己的序号；客户端再回 ACK 确认。

两次不够的原因有两个：服务端发出 SYN 加 ACK 后并不知道客户端是否收到；网络上延迟很久的旧 SYN 到达时，服务端会白白建立一条连接并分配资源，等不到确认才释放。

四次挥手是因为 TCP 全双工，两个方向要各自关闭：主动方发 FIN 表示自己没数据要发了；被动方先回 ACK，此时主动方到被动方方向已关闭，但被动方可能还有数据要发；等它发完再发自己的 FIN；主动方最后 ACK 并进入 TIME_WAIT，等待 2MSL 后关闭。

主动方等 2MSL 有两个作用：一是保证最后一个 ACK 能到达对端，丢了对方会重发 FIN，自己还在才能重新响应；二是让本次连接的旧报文在网络中彻底消失，不会串到下一个相同四元组的新连接里。

线上大量 TIME_WAIT 通常是短连接太多，先考虑改成连接池复用长连接，实在不行再调 net.ipv4.tcp_tw_reuse 允许复用，不要动 tcp_tw_recycle，它在 NAT 环境下会导致丢包，新内核已经移除。`,
    points: ["三次握手双向确认并防止历史连接", "全双工导致两个方向分别关闭", "2MSL 的两个作用"],
    follow: "服务器上大量 TIME_WAIT 怎么办？",
    sources: [{ repo: "CS-Notes", path: "docs/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-network-http-https",
    category: "backend",
    topic: "网络",
    difficulty: 2,
    tags: ["网络", "HTTPS", "TLS", "HTTP/2"],
    question: "HTTPS 的握手过程是怎样的？HTTP/2 改了什么？",
    answer: `HTTPS 就是 HTTP 加 TLS。握手大致是：客户端发 ClientHello，带上支持的 TLS 版本、加密套件和一个随机数；服务端回 ServerHello，选定套件、给出自己的随机数，并发送证书链；客户端验证证书链是否可信、域名是否匹配、是否在有效期内、有没有被吊销，然后生成预主密钥，用证书里的公钥加密后发过去；双方用两个随机数加预主密钥推导出会话密钥，之后就用对称加密通信。

非对称加密只用来安全地交换密钥，因为它慢；业务数据用对称加密，因为它快。TLS 1.3 把握手压缩到一次往返，并支持会话恢复时的 0-RTT，代价是 0-RTT 数据存在重放风险，只能用于幂等请求。

HTTP/2 的关键改动：

- 多路复用：一条 TCP 连接上并发跑多个流，每个流有独立 id，解决了 HTTP/1.1 的队头阻塞和浏览器六连接限制。
- 头部压缩 HPACK，静态表和动态表结合，重复的 header 只传索引。
- 二进制分帧，取代了文本协议。
- 服务端推送，可以主动推资源，但实际效果不好，很多场景已弃用。

HTTP/2 在 TCP 层依然有队头阻塞，一个包丢了所有流都要等重传，这才是 HTTP/3 改用 QUIC 跑在 UDP 上的根本原因。`,
    points: ["非对称交换密钥、对称加密数据", "证书校验与 TLS 1.3 的优化", "HTTP/2 多路复用与头部压缩"],
    follow: "HTTP/3 为什么要改用 QUIC？",
    sources: [{ repo: "CS-Notes", path: "docs/" }, { repo: "athena", path: "doc/" }],
  },

  {
    id: "backend-basis-string",
    category: "backend",
    topic: "Java 基础",
    difficulty: 1,
    tags: ["Java 基础", "String", "常量池", "不可变"],
    question: "String 为什么设计成不可变的？拼接字符串该怎么做？",
    answer: `不可变指的是内部用 final 修饰的数组保存内容，而且不对外暴露任何修改方法，所有看似修改的操作都返回新对象。

好处有三条：线程安全，多线程共享不需要同步；可以安全地当 HashMap 的 key，hash 值能缓存下来不用每次重算；字符串常量池才有意义，多个引用指向同一份数据，省内存。

字符串常量池在 JDK 7 之后从方法区挪到了堆里，原因是永久代回收效率低、容易 OOM，放到堆里能受正常的 GC 管理。

拼接要分场景：

- 编译期能确定的字面量拼接，编译器直接合成一个常量，运行时没有额外开销。
- 带变量的拼接，JDK 9 之前编译成 StringBuilder 的 append 链，JDK 9 之后改成 invokedynamic 加 StringConcatFactory，由运行时决定最优策略。
- 循环里的拼接，一定显式用 StringBuilder 并在已知大小时指定初始容量，否则每次迭代都可能创建新对象。
- 多线程拼接用 StringBuffer，或者干脆用 ThreadLocal 的 StringBuilder。

两个高频细节：用加号拼 null 会得到字符串 null 而不是抛异常；字符串常量池里的对象不要用 intern 滥用，JDK 7 之后 intern 会把首次出现的字符串放进堆里的常量池，大量唯一字符串会导致常量池膨胀。`,
    points: ["final 数组且不暴露修改方法", "线程安全、hash 缓存、常量池复用", "循环拼接用 StringBuilder"],
    follow: "字符串常量池在 JDK 7 之后有什么变化？",
    sources: [{ repo: "JavaGuide", path: "docs/java/basis/" }, { repo: "CS-Notes", path: "docs/" }],
  },
];
