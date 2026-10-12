// 面试题库 · 后端 · 集合与泛型。
//
// 本文件是「面试刷题」工具的离线题库数据源之一，覆盖 Java 集合框架的三条线：
// HashMap 的结构与扩容、各类 Map 的选型、ConcurrentHashMap 与 CopyOnWriteArrayList
// 的线程安全实现、阻塞队列与线程池的配合、PriorityQueue 与堆、迭代器与比较器，
// 以及 Stream 惰性求值、Collectors 下游收集器、Optional 用法和泛型擦除。
//
// 只导出 BACKEND_COLLECTION_QUESTIONS 一个常量数组，不依赖任何运行时、不发网络请求，
// 由 UI 层按 topic 分组、按 difficulty 排序、按 tags 检索。
//
// 出处约定（与 interviewBankBackend.js 一致）：每道题的 sources 只记录「来源仓库 + 仓库内
// 相对路径」，不写完整 URL，链接由 interviewBank.js 的 sourceLinks 统一拼；repo 限定为
// JavaGuide / advanced-java / CS-Notes / athena / bestJavaer 五个键，path 必须是这些仓库里
// 真实存在的相对路径前缀。新增题目请沿用同一约定。
//
// id 统一用 backend-collection- 前缀，并刻意避开 interviewBankBackend.js 里已有的集合题 id
// （hashmap-resize / concurrenthashmap / arraylist-vs-linkedlist / hashmap-thread-unsafe），
// 这样两个文件一起并进 BUILTIN_QUESTIONS 时不会撞 id 被静默吞掉。
//
// 注意：question / answer / points / follow 里不要出现花括号，会破坏应用内的 i18n 消息编译
// （answer 的围栏代码块本可例外，本文件仍刻意只写无花括号的单行示例，避免任何歧义）。

export const BACKEND_COLLECTION_QUESTIONS = [
  {
    id: "backend-collection-hashmap-capacity-resize",
    category: "backend",
    topic: "集合",
    difficulty: 2,
    tags: ["HashMap", "扩容", "红黑树"],
    question: "HashMap 的容量为什么必须是 2 的幂？扩容时链表是怎么拆的？",
    answer: `结论：容量取 2 的幂是为了把取模换成位运算，扩容时按高位判断把一条链拆成两条，不用重算 hash。

- 寻址用 (n - 1) & hash，n 是 2 的幂时低位全是 1，等价于取模而且更快。默认容量 16，负载因子 0.75，阈值 12，超过就翻倍。
- 扰动函数把 hash 的高 16 位异或进低位，避免高位差异被丢掉。
- JDK 8 的 resize 判断 hash 与 oldCap 做与运算的结果是否为 0：为 0 留在原下标，否则移到原下标加 oldCap，两条链的相对顺序都不变；JDK 7 是头插法，会逆序。
- 链表长度到 8 且容量到 64 才树化，元素降到 6 退回链表。

排查：JDK 7 并发扩容会成环、CPU 打满；JDK 8 不成环了，但依然不是线程安全的。`,
    points: ["负载因子 0.75 与两倍扩容", "按高位拆分高低两条链", "树化 8 与退化 6 的阈值"],
    follow: "为什么树化阈值是 8，退化阈值却是 6？",
    sources: [{ repo: "JavaGuide", path: "docs/java/collection/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-collection-hashmap-concurrency-pitfalls",
    category: "backend",
    topic: "集合",
    difficulty: 3,
    tags: ["HashMap", "线程安全", "死循环"],
    question: "HashMap 线程不安全具体表现在哪里？JDK 8 修好了吗？",
    answer: `结论：JDK 7 是并发扩容成环打满 CPU；JDK 8 改尾插后不再成环，但数据覆盖、计数丢失、丢元素依然存在。

- 数据覆盖：putVal 发现桶为空就直接赋值，两个线程同时判空，后写的顶掉先写的，元素消失。
- 计数不准：size 是普通 int，自增不是原子操作，并发下偏小，还会让扩容时机判断失真。
- 并发扩容：两个线程同时 resize，新数组可能被覆盖，搬迁期间写入的元素会丢。
- JDK 7 特有：transfer 用头插法，两个线程同时搬同一条链会互相指向形成环，之后 get 到这个桶就死循环。
- 迭代：结构被修改时 modCount 与 expectedModCount 不一致就抛并发修改异常，这只是尽力而为的检测，不保证每次都触发。

所以并发场景用 ConcurrentHashMap，别用全局锁的 synchronizedMap。`,
    points: ["并发 put 的数据覆盖与 size 少算", "JDK 7 头插法形成环形链表", "fail-fast 只是尽力而为的检测"],
    follow: "为什么 JDK 8 把头插法改成尾插法？",
    sources: [{ repo: "JavaGuide", path: "docs/java/collection/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-collection-map-selection",
    category: "backend",
    topic: "集合",
    difficulty: 1,
    tags: ["HashMap", "TreeMap", "LinkedHashMap", "Hashtable"],
    question: "HashMap、Hashtable、TreeMap、LinkedHashMap 该怎么选？",
    answer: `结论：一般用 HashMap；要排序或范围查询用 TreeMap；要可预测顺序或做 LRU 用 LinkedHashMap；Hashtable 已过时。

- HashMap：数组加链表加红黑树，无序，允许一个 null 键和多个 null 值，平均查询是 O(1)，线程不安全。
- Hashtable：方法全部加锁，全表一把锁，不允许 null 键值，新代码一律用 ConcurrentHashMap 替代。
- TreeMap：红黑树，按自然顺序或比较器排序，支持取最小键、取子区间等范围查询，键不能为 null。
- LinkedHashMap：多了双向链表，默认按插入顺序迭代；accessOrder 传 true 就按访问顺序，重写 removeEldestEntry 就是一个 LRU 缓存。

补充：键参与哈希后别再改它，hashCode 变了就找不回来。`,
    points: ["无序用 HashMap，排序用 TreeMap", "accessOrder 与 LRU 的实现方式", "Hashtable 全表锁已被淘汰"],
    follow: "LinkedHashMap 怎么做带过期时间的缓存？",
    sources: [{ repo: "JavaGuide", path: "docs/java/collection/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-collection-concurrenthashmap-jdk7-vs-8",
    category: "backend",
    topic: "并发容器",
    difficulty: 3,
    tags: ["ConcurrentHashMap", "分段锁", "CAS", "synchronized"],
    question: "ConcurrentHashMap 在 JDK 7 和 JDK 8 里分别怎么保证线程安全？",
    answer: `结论：JDK 7 是分段锁，每段一把 ReentrantLock；JDK 8 去掉分段，改成 CAS 加 synchronized 锁单个桶，支持协助扩容。

- JDK 7：Segment 数组默认 16 段，并发度由 concurrencyLevel 决定，每段内部是 HashEntry 数组。get 不加锁，靠 volatile 保证可见性；put 只锁所在段。缺点是并发度被段数钉死。
- JDK 8：结构回到 Node 数组加链表加红黑树。桶为空时用 CAS 写入，桶非空时锁住头节点，锁粒度从段降到桶。计数用 baseCount 加 CounterCell 分散热点，size 只是估算值。
- 扩容：搬完的桶放一个 ForwardingNode，其他线程遇到就一起搬。

实践：复合操作用 putIfAbsent、computeIfAbsent、merge，别先查再写。`,
    points: ["7 分段锁，8 的 CAS 加 synchronized", "锁粒度从段降到单个桶", "size 是估算值不是精确值"],
    follow: "computeIfAbsent 在什么情况下会阻塞其他线程？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "backend-collection-concurrenthashmap-null-forbidden",
    category: "backend",
    topic: "并发容器",
    difficulty: 2,
    tags: ["ConcurrentHashMap", "null", "NPE"],
    question: "ConcurrentHashMap 为什么不允许 null 键和 null 值？",
    answer: `结论：并发下无法安全地区分「键不存在」和「值就是 null」，所以 putVal 里直接判空抛空指针异常。

- 单线程的 HashMap 允许 null，get 返回 null 之后还能再调一次 containsKey 确认，这个判断是有意义的。
- 并发下这两次调用之间集合可能已经被别的线程改掉，containsKey 的结果立刻失效；要把它做成原子判断就得额外加锁，收益不值得这个代价。
- 二义性会传染给调用方：拿到的 null 既可能是「没有」，也可能是「有但是空」，调用方只能靠约定去猜。
- 顺带一提，HashMap 把 null 键的 hash 当 0 处理放在 0 号桶，ConcurrentHashMap 连这一步都不做。

实践：需要表达空值时用哨兵对象或者 Optional 包装，别指望集合本身表达。`,
    points: ["null 无法区分不存在与空值", "并发下 containsKey 判断会失效", "HashMap 的 null 键落在 0 号桶"],
    follow: "HashMap 的 null 键是怎么计算下标的？",
    sources: [{ repo: "JavaGuide", path: "docs/java/collection/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-collection-copyonwritearraylist",
    category: "backend",
    topic: "并发容器",
    difficulty: 2,
    tags: ["CopyOnWriteArrayList", "写时复制", "弱一致性"],
    question: "CopyOnWriteArrayList 适合什么场景？代价是什么？",
    answer: `结论：适合读多写极少、数据量小的场景，比如监听器列表和白名单；写操作要复制整个数组，频繁写会打爆内存和 GC。

- 写：加 ReentrantLock 后复制一份新数组，改完再用 setArray 把 volatile 引用指过去，读操作全程无锁。
- 读：直接读当前数组引用，读性能极好，也不会抛并发修改异常。
- 迭代器是创建那一刻的快照，之后集合的修改它看不到，这就是弱一致性；快照迭代器不支持 remove、set、add，调用抛不支持操作异常。
- 代价：每次写都要复制，内存瞬时翻倍，数组越大复制越贵；并发写入时 size 读到的也可能是旧值。

实践：元素多、写频繁就别用；替代方案是 ConcurrentHashMap，或者自己加锁的 ArrayList。`,
    points: ["写时复制加 volatile 数组引用", "读无锁但写要复制整个数组", "迭代器是快照，弱一致性"],
    follow: "它和 Collections.synchronizedList 怎么选？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-collection-arraylist-linkedlist-tradeoff",
    category: "backend",
    topic: "集合",
    difficulty: 1,
    tags: ["ArrayList", "LinkedList", "扩容"],
    question: "ArrayList 和 LinkedList 的真实差异是什么？",
    answer: `结论：ArrayList 是动态数组，LinkedList 是双向链表；真实项目里绝大多数场景选 ArrayList，LinkedList 只在已拿到节点又频繁增删时才有优势。

- 随机访问：ArrayList 按下标直接取 O(1)；LinkedList 要遍历，O(n)。
- 中间插入：ArrayList 要搬移后面的元素，O(n)，但 System.arraycopy 是连续内存拷贝，常数很小；LinkedList 改指针是 O(1)，前提是已拿到那个节点。
- 内存：LinkedList 每个节点多存前后指针，约 40 字节，节点分散在堆上，缓存命中率差。
- 扩容：ArrayList 默认容量 10，第一次 add 才真正分配，扩容为原来的 1.5 倍并整体复制，能预估大小就用带参构造。

队列和栈用 ArrayDeque，它比 LinkedList 快，也不允许 null。`,
    points: ["随机访问与中间插入的复杂度", "默认容量 10 与 1.5 倍扩容", "队列场景用 ArrayDeque"],
    follow: "ArrayList 扩容为什么是 1.5 倍而不是 2 倍？",
    sources: [{ repo: "JavaGuide", path: "docs/java/collection/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-collection-fail-fast-vs-fail-safe",
    category: "backend",
    topic: "集合",
    difficulty: 2,
    tags: ["fail-fast", "迭代器", "并发修改异常"],
    question: "fail-fast 和 fail-safe 迭代器有什么区别？",
    answer: `结论：fail-fast 检测到结构性修改就抛并发修改异常；fail-safe 在快照上迭代，不抛异常但看不到最新数据。

- fail-fast：ArrayList、HashMap 的迭代器保存 expectedModCount，每次 next 与 modCount 比对，不等就抛。它只是尽力而为的检测，不保证触发。
- 删除要用 Iterator.remove，它会同步更新 expectedModCount；在增强 for 里直接删是最常见的翻车写法。
- fail-safe：CopyOnWriteArrayList 的迭代器基于快照，ConcurrentHashMap 的弱一致，都不抛异常，但遍历期间的新增删除看不到。
- 替代写法：JDK 8 的 removeIf 内部有自己的机制，比手写迭代器安全。

排查：先看是不是遍历里改了集合，再看是不是共享了非并发容器。`,
    points: ["modCount 与期望值比对", "遍历中删除要用 Iterator.remove", "快照迭代器弱一致但不报错"],
    follow: "ConcurrentHashMap 的迭代器为什么不会抛异常？",
    sources: [{ repo: "JavaGuide", path: "docs/java/collection/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-collection-blocking-queue-selection",
    category: "backend",
    topic: "并发容器",
    difficulty: 3,
    tags: ["阻塞队列", "线程池", "ArrayBlockingQueue", "SynchronousQueue"],
    question: "常用阻塞队列有什么区别？线程池里该怎么选？",
    answer: `结论：区别在容量、锁粒度和是否有界。线程池优先用有界队列，无界队列在任务堆积时只会吃光内存。

- ArrayBlockingQueue：数组实现，容量必须指定，一把锁配两个 Condition，吞吐一般但内存可控。
- LinkedBlockingQueue：链表加两把锁，读写互不阻塞，吞吐更高；默认容量是 Integer.MAX_VALUE，等于无界，线程池里必须传容量。
- SynchronousQueue：不存元素，生产者要等到消费者接手，newCachedThreadPool 用的就是它，来一个任务开一个线程。
- DelayQueue：无界，元素实现 Delayed，按到期时间排序，take 阻塞到最早元素到期，用于定时任务和缓存过期。
- 选型：固定线程数用 ArrayBlockingQueue 加小容量，满了走 CallerRunsPolicy 做背压。`,
    points: ["单锁与双锁队列的吞吐差异", "LinkedBlockingQueue 默认近似无界", "有界队列加 CallerRunsPolicy 背压"],
    follow: "线程池队列满了之后任务是怎么被拒绝的？",
    sources: [{ repo: "JavaGuide", path: "docs/java/concurrent/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "backend-collection-priorityqueue-heap",
    category: "backend",
    topic: "集合",
    difficulty: 2,
    tags: ["PriorityQueue", "堆", "TopK"],
    question: "PriorityQueue 的底层是什么？为什么它的迭代顺序是乱的？",
    answer: `结论：底层是完全二叉堆，用数组存，默认小顶堆，初始容量 11；只保证堆顶最小，迭代顺序不保证有序。

- 结构：下标 i 的左右孩子在 2i 加 1 和 2i 加 2，父节点是 (i - 1) 除以 2，不用指针。
- 操作：peek 是 O(1)，offer 和 poll 靠 siftUp、siftDown 调整，都是 O(log n)；用集合构造走 heapify 建堆是 O(n)，逐个 add 是 O(n log n)。
- 约束：元素要么实现 Comparable，要么传 Comparator；不允许 null，也不是线程安全的，并发用 PriorityBlockingQueue。
- 迭代：iterator 只按数组顺序遍历，只有第一个元素最小，要按序取只能反复 poll。

TopK 就用它：求最大的 K 个维护容量 K 的小顶堆，比堆顶大就替换，时间 O(n log K)。`,
    points: ["数组存完全二叉堆的下标关系", "heapify 建堆是 O(n)", "迭代器不保证有序，只保证堆顶"],
    follow: "求第 K 大为什么用小顶堆而不是大顶堆？",
    sources: [{ repo: "JavaGuide", path: "docs/java/collection/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-collection-iterator-vs-listiterator",
    category: "backend",
    topic: "集合",
    difficulty: 1,
    tags: ["Iterator", "ListIterator", "迭代器"],
    question: "Iterator 和 ListIterator 有什么区别？",
    answer: `结论：ListIterator 继承自 Iterator，多了双向遍历和遍历中修改的能力，只有 List 才提供。

- Iterator：hasNext、next、remove 三个方法，只能单向向后走；remove 是唯一允许的修改，而且必须先调用过 next。
- ListIterator：由 listIterator 获取，多了向前遍历、读游标下标、set 替换元素、add 插入元素这些能力，且不会抛并发修改异常。
- 游标：两个下标方法分别给出下一次向后、向前会取到的位置，长度为 n 的列表共有 n 加 1 个游标位置。
- 常见用途是倒序遍历，以及在遍历过程中替换或插入元素。

注意：remove 和 set 之前必须先 next 或 previous，否则抛非法状态异常。`,
    points: ["ListIterator 多了双向与增删改", "只有 List 提供 listIterator", "remove 前必须先 next 或 previous"],
    follow: "倒序遍历 List 有哪几种写法？",
    sources: [{ repo: "JavaGuide", path: "docs/java/collection/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-collection-comparable-vs-comparator",
    category: "backend",
    topic: "集合",
    difficulty: 2,
    tags: ["Comparable", "Comparator", "排序"],
    question: "Comparable 和 Comparator 有什么区别？什么时候必须用后者？",
    answer: `结论：Comparable 是类内部的自然排序，一个类只能有一种；Comparator 是外部策略，可以有很多种，也不用改被比较的类。

- Comparable：实现 compareTo，用在 TreeMap、TreeSet 的默认排序上；返回值负数、0、正数分别表示小于、等于、大于。
- Comparator：实现 compare，通过 list.sort 或 TreeMap 的构造参数传入；JDK 8 起有 comparing、thenComparing 等静态方法，链式写法很省事。
- 必须用后者的场景：类是第三方库的改不了；同一个类要按多个字段或多种规则排序；要把 null 排到前面。
- 契约：比较关系要满足自反、传递、反对称，违反传递性时 TimSort 会抛非法参数异常。
- 坑：别用两个数相减当返回值，整数溢出会排错，要用 Integer.compare。`,
    points: ["自然排序与外部策略的取舍", "comparing 链式排序的写法", "compareTo 与 equals 不一致的坑"],
    follow: "Comparator 违反传递性会报什么错？",
    sources: [{ repo: "JavaGuide", path: "docs/java/collection/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-collection-stream-lazy-evaluation",
    category: "backend",
    topic: "Stream 与函数式",
    difficulty: 2,
    tags: ["Stream", "惰性求值", "短路操作"],
    question: "Stream 的惰性求值是怎么体现的？短路操作有什么价值？",
    answer: `结论：中间操作只是把流水线搭起来，不执行；只有终止操作才真正遍历数据。短路操作让流提前结束，能处理无限流。

- 中间操作：filter、map、sorted 都返回新的 Stream，调用时一行数据都不会处理。
- 终止操作：collect、forEach、count、anyMatch 才触发执行，元素依次流过整条流水线，所以 filter 放前面能少调用很多次 map。
- 流只能消费一次，重复使用抛非法状态异常。
- 短路：anyMatch、findFirst、limit 拿到结果就停，配合 Stream.iterate 就能写无限流。

\`\`\`java
Stream.iterate(1, i -> i + 1).filter(i -> i % 7 == 0).findFirst();
\`\`\`

注意 sorted 是有状态操作，要等所有元素到齐才发出第一个，和无限流一起用会卡死。`,
    points: ["中间操作不执行，终止操作才触发", "短路让无限流可以结束", "sorted 是有状态操作不能配无限流"],
    follow: "peek 能不能用来做业务逻辑？",
    sources: [{ repo: "JavaGuide", path: "docs/java/new-features/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-collection-collectors-downstream",
    category: "backend",
    topic: "Stream 与函数式",
    difficulty: 2,
    tags: ["Collectors", "groupingBy", "toMap"],
    question: "Collectors 里常用的下游收集器怎么用？",
    answer: `结论：Collectors 把流收成集合、字符串或统计值，groupingBy 和 partitioningBy 还能再挂一个下游收集器做二次聚合。

- 基础：toList、toSet 控制目标集合类型；joining 支持分隔符、前缀和后缀。
- toMap：key 冲突会抛异常，要用三参版本给一个合并函数；value 为 null 也会抛空指针。
- 分组：groupingBy 默认收成 HashMap，需要有序就传 TreeMap 的三参版本；下游可以是计数、求和，或者先映射再收集。
- partitioningBy 按条件只分两组，下游规则完全一样。

实践：分组加映射能替代嵌套循环里手写的 Map 与 List 初始化，代码短很多。`,
    points: ["toMap 的 key 冲突要合并函数", "groupingBy 可挂下游收集器", "partitioningBy 只分两组"],
    follow: "groupingBy 默认返回的 Map 是什么实现？",
    sources: [{ repo: "JavaGuide", path: "docs/java/new-features/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-collection-optional-usage",
    category: "backend",
    topic: "Stream 与函数式",
    difficulty: 2,
    tags: ["Optional", "空指针", "orElseGet"],
    question: "Optional 的正确用法是什么？常见的误用有哪些？",
    answer: `结论：Optional 只用来表达「方法返回值可能没有」，不要当字段、参数或集合元素用，也别指望它替代所有判空。

- 取值：orElse 的参数无论是否为空都会求值，里面是查库或建对象这类有开销、有副作用的表达式时，要用 orElseGet 延迟求值。
- 别用 get：为空时抛无此元素异常还没有任何信息，用 orElseThrow 传自定义异常。
- 误用：Optional.of 传 null 直接抛空指针，要用 ofNullable；字段、参数、集合元素上加 Optional 会增加包装和序列化的麻烦；集合返回值应该给空集合。
- 命令式的 isPresent 加 get 等于换个名字判空，用 map、filter、ifPresent 链式处理更清楚。

JDK 9 起还有 or、ifPresentOrElse，JDK 11 加了 isEmpty。`,
    points: ["orElse 与 orElseGet 的求值时机", "ofNullable 与 orElseThrow 的用法", "不要当字段和参数用"],
    follow: "Optional 为什么不能序列化？",
    sources: [{ repo: "JavaGuide", path: "docs/java/new-features/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-collection-generics-erasure",
    category: "backend",
    topic: "集合",
    difficulty: 3,
    tags: ["泛型", "类型擦除", "堆污染"],
    question: "泛型擦除对集合 API 有哪些实际影响？",
    answer: `结论：泛型只在编译期存在，运行时被擦除到上界，带不同参数的 List 在 JVM 眼里是同一个类，所以有些写法编译不过，有些错误要到运行时才暴露。

- 编译限制：不能直接 new 泛型数组，不能对带参数的泛型做 instanceof，也不能重载只有泛型参数不同的两个方法，编译器会报 name clash。
- 运行时：取元素时编译器插入 checkcast。用反射或原始类型绕过检查塞进错类型就是堆污染，取出来才抛类型转换异常，离出错点很远。
- 需要类型信息时：传 Class 对象，或者用 TypeReference、ParameterizedType 从父类签名里取，Jackson 反序列化就是这么做的。
- 通配符：数组协变而泛型不变，要用 extends 读、super 写，即 PECS 原则。

实践：@SafeVarargs 只加在确实安全的可变参数方法上，否则等于关掉警告。`,
    points: ["擦除到上界，运行时没有泛型信息", "堆污染让异常远离出错点", "extends 读、super 写的 PECS 原则"],
    follow: "为什么泛型数组不能直接创建？",
    sources: [{ repo: "JavaGuide", path: "docs/java/basis/" }, { repo: "CS-Notes", path: "docs/" }],
  },
];
