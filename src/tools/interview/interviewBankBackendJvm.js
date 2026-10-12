// 面试题库 · Java 后端 / JVM 与性能排查。
//
// 覆盖四块：JVM 内存结构与调优参数、GC 算法与收集器、类加载机制、线上排查（CPU、内存、GC）。
// 只导出 BACKEND_JVM_QUESTIONS 一个常量数组，不依赖任何运行时、不发网络请求，
// 由 UI 层按 topic 分组、按 difficulty 排序、按 tags 检索，id 统一用 backend-jvm- 前缀。
//
// 出处约定：sources 只写「来源仓库键 + 仓库内相对路径」，不写完整 URL，URL 由 interviewBank.js
// 的 sourceLinks 统一拼接；repo 限定 JavaGuide / advanced-java / CS-Notes / athena / bestJavaer，
// path 必须是这些仓库里真实存在的前缀，写错只会在界面上渲染出一个 404，所以新增题目请沿用同一约定。
// 注意：question / points / follow 里不能出现裸花括号，会打断应用内的 i18n 消息编译；
// answer 里的花括号只在代码块内出现。

export const BACKEND_JVM_QUESTIONS = [
  {
    id: "backend-jvm-memory-areas",
    category: "backend",
    topic: "JVM",
    difficulty: 1,
    tags: ["JVM", "运行时数据区", "内存结构", "OOM"],
    question: "JVM 运行时数据区怎么划分？哪些区域会抛 OutOfMemoryError？",
    answer: `运行时数据区分五块：程序计数器、虚拟机栈、本地方法栈线程私有，堆和方法区线程共享。

- 程序计数器记录当前字节码行号，是唯一不会抛 OutOfMemoryError 的区域。
- 虚拟机栈一次方法调用对应一个栈帧，深度超限抛 StackOverflowError，由 -Xss 控制，默认 1MB。
- 堆放对象实例，新生代默认占三分之一，由 -Xms、-Xmx 控制，溢出报 Java heap space。
- 方法区在 JDK 8 起由元空间实现，改用本地内存，溢出报 Metaspace；直接内存不算运行时数据区，NIO 的 DirectByteBuffer 默认上限等于 -Xmx。

排查先看异常类型：Java heap space 去 dump 堆；Metaspace 或 Direct buffer memory 说明问题在堆外，jstat 看不出来，要用 NMT 或 pmap。`,
    points: ["五块区域的线程归属", "各区域对应的溢出类型", "堆外问题要用 NMT 定位"],
    follow: "为什么程序计数器是唯一不会内存溢出的区域？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-jvm-object-layout",
    category: "backend",
    topic: "JVM",
    difficulty: 2,
    tags: ["JVM", "对象头", "指针压缩", "内存布局"],
    question: "一个 Java 对象在堆里占多大？对象头和指针压缩是怎么回事？",
    answer: `结论：对象由对象头、实例数据、对齐填充组成，64 位 HotSpot 上 new Object() 通常是 16 字节。

- 对象头里 Mark Word 占 8 字节，存哈希码、GC 年龄和锁状态；类型指针指向 Klass，开启压缩后 4 字节，关闭是 8 字节。数组对象还要多 4 字节存长度。
- 指针压缩由 -XX:+UseCompressedOops 控制，64 位 JDK 6 之后默认开启，堆小于 32G 才生效。堆超过 32G 压缩失效，同样的对象会变大，这是堆不是越大越好的原因之一。
- 对齐填充让对象起始地址按 8 字节对齐；字段会按 long、double、引用、int 的顺序重排，把空隙压到最小。

创建对象走五步：类加载检查、分配内存（指针碰撞或空闲列表，优先在 TLAB 上分配）、内存置零、设置对象头、执行构造方法。`,
    points: ["对象头两个字段各占多少", "指针压缩的开关与 32G 边界", "创建五步与 TLAB 分配"],
    follow: "为什么堆内存不建议超过 32G？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-jvm-gc-roots",
    category: "backend",
    topic: "JVM",
    difficulty: 2,
    tags: ["GC Roots", "可达性分析", "引用类型"],
    question: "JVM 怎么判断对象已经死了？GC Roots 都包含哪些？",
    answer: `结论：HotSpot 用可达性分析判定对象存活，不用引用计数。

- 引用计数要为每次赋值维护计数，并发下开销大，更致命的是解决不了循环引用，主流 JVM 都没采用。
- 可达性分析从 GC Roots 出发遍历引用链，走不到的对象判定可回收。GC Roots 包括虚拟机栈局部变量表的引用、本地方法栈的 JNI 引用、方法区静态属性与常量引用、synchronized 持有的锁对象，以及系统类加载器等虚拟机内部引用。
- 引用强度也影响回收：强引用不动；软引用内存不足时回收；弱引用下次 GC 必回收，ThreadLocalMap 的 key 就是弱引用；虚引用只做回收通知。
- 不可达对象还有一次自救机会，在 finalize 里重新建立引用，但只执行一次，生产代码不要依赖。

排查泄漏时用 MAT 反查 Path to GC Roots 并排除弱引用，能看出是哪个静态集合把它挂住了。`,
    points: ["不用引用计数的两个原因", "GC Roots 的常见来源", "四种引用强度与自救机会"],
    follow: "ThreadLocal 的内存泄漏是怎么发生的？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-jvm-gc-algorithms",
    category: "backend",
    topic: "GC",
    difficulty: 1,
    tags: ["GC", "标记清除", "复制算法", "标记整理"],
    question: "标记清除、复制、标记整理三种算法各有什么优缺点？",
    answer: `结论：三种算法在停顿、碎片、空间利用率上各有取舍，分代收集按对象存活率分别使用它们。

- 标记清除：标记出可回收对象后直接清理，实现简单也不移动对象，但会留下大量碎片，清除效率随对象数下降，CMS 用的是它。
- 复制：把存活对象复制到另一半空间再整体清空，没有碎片、分配只要移动指针，代价是可用空间减半；存活率低时复制量很小，所以新生代用它，Eden 与两个 Survivor 默认 8:1:1，只浪费十分之一。
- 标记整理：标记后把存活对象向一端移动再清理边界外内存，既没有碎片也不浪费空间，但移动对象要更新引用，停顿最长，Serial Old 和 Parallel Old 用它。

依据是弱分代假说：绝大多数对象朝生夕死。老年代碎片会让大对象分配失败触发 Full GC，CMS 下表现为 Concurrent Mode Failure，可以定期整理或换 G1。`,
    points: ["三种算法的取舍对比", "新生代 8:1:1 复制", "碎片导致 Full GC 与对策"],
    follow: "新生代为什么需要两个 Survivor 区？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-jvm-collector-selection",
    category: "backend",
    topic: "GC",
    difficulty: 3,
    tags: ["G1", "CMS", "ZGC", "收集器选型"],
    question: "Serial、Parallel、CMS、G1、ZGC 怎么选？各自停顿目标和适用堆多大？",
    answer: `结论：选型只看能容忍的停顿和堆有多大。

- Serial：单线程，停顿几十到几百毫秒，适合几百 MB 的小服务，用 -XX:+UseSerialGC。
- Parallel：吞吐优先，停顿百毫秒级，适合 1 到 4G 的批处理，JDK 8 服务端默认就是它。
- CMS：并发标记清除，主打低停顿，适合 4 到 8G，但有碎片和 Concurrent Mode Failure 风险，JDK 9 废弃、14 移除。
- G1：-XX:+UseG1GC，JDK 9 起默认，停顿目标 -XX:MaxGCPauseMillis 默认 200ms，适合 4 到 16G。
- ZGC：-XX:+UseZGC，染色指针加读屏障，停顿 1ms 以内且几乎不随堆增长，适合 16G 以上大堆，代价是吞吐降约一成。

实践：先用 -Xlog:gc 看真实停顿分布，再调停顿目标，别照抄参数。`,
    points: ["五种收集器的停顿与堆区间", "JDK 8 与 JDK 9 的默认收集器", "用 GC 日志验证而不是抄参数"],
    follow: "ZGC 的染色指针为什么能做到亚毫秒停顿？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-jvm-g1-region-mixed-gc",
    category: "backend",
    topic: "GC",
    difficulty: 3,
    tags: ["G1", "Mixed GC", "Region", "停顿预测"],
    question: "G1 的 Region 怎么划分？Mixed GC 什么时候触发，停顿怎么预测？",
    answer: `结论：G1 把堆切成等大的 Region，按回收收益挑一部分回收，用停顿预测模型压住停顿。

- Region 大小 1 到 32MB 且是 2 的幂，默认按堆大小除以 2048 算；Region 逻辑上分 Eden、Survivor、Old，超过一半的大对象进 Humongous。
- 老年代占用超过 -XX:InitiatingHeapOccupancyPercent（默认 45%）时启动并发标记，完成后进入 Mixed GC，回收全部新生代加收益高的老年代；标记跟不上分配就退化成 Full GC。
- 停顿预测模型用衰减平均值统计每个 Region 的垃圾占比和耗时，按 -XX:MaxGCPauseMillis（默认 200ms）从收益高到低挑 Region 回收。

实践：日志里出现 to-space exhausted 说明晋升失败或大对象太多，先加大堆。`,
    points: ["Region 大小与 Humongous 判定", "Young、Mixed、Full 三种回收", "衰减平均值挑 Region"],
    follow: "G1 的 Humongous 对象为什么会拖慢回收？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-jvm-tricolor-marking",
    category: "backend",
    topic: "GC",
    difficulty: 3,
    tags: ["三色标记", "读写屏障", "漏标", "SATB"],
    question: "并发标记里的三色标记是什么？为什么会漏标，怎么解决？",
    answer: `结论：三色标记把对象分成白、灰、黑三种状态，让用户线程继续跑的同时完成可达性分析。

- 白色是还没被访问到，灰色是自己访问到了但引用还没扫完，黑色是自身和引用都扫完了；标记结束时还是白色的对象就是垃圾。
- 漏标要同时满足两个条件：黑色对象新增了指向白色对象的引用，同时灰色对象到该白色对象的引用被删除。黑色不会再被扫描，白色又脱离了灰色可达范围，于是被漏掉。
- 解法是破坏其中一个条件。增量更新记录黑色到白色的新增引用，重新标记时把这些黑色对象当根再扫一遍，CMS 用写后屏障实现；原始快照 SATB 记录被删除的引用，认为标记开始时活的对象都算活，G1 用写前屏障。
- SATB 让重新标记更短，代价是浮动垃圾更多；G1 里并发周期中新分配的对象落在 TAMS 之上，默认视为存活。

实践：Remark 阶段很长说明引用修改频繁、写屏障开销大，可以从减少大对象入手。`,
    points: ["白灰黑三种状态的语义", "漏标的两个必要条件", "增量更新与 SATB 的区别"],
    follow: "CMS 的重新标记和 G1 的有什么不同？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-jvm-class-loading-steps",
    category: "backend",
    topic: "类加载",
    difficulty: 2,
    tags: ["类加载", "准备阶段", "初始化", "ClassLoader"],
    question: "类加载分哪几个阶段？准备阶段和初始化阶段有什么区别？",
    answer: `结论：完整过程是加载、验证、准备、解析、初始化，解析可以延迟到初始化之后。

- 加载：按全限定名拿到字节流，在方法区生成类结构，并在堆里创建 Class 对象。
- 验证：做文件格式、元数据、字节码、符号引用四层校验。
- 准备：给静态变量分配内存并赋零值，int 是 0、引用是 null；只有 final 常量带 ConstantValue 属性，会在这一步直接赋真值。
- 解析：把常量池的符号引用替换成直接引用，为了支持多态可以推迟到首次使用时。
- 初始化：执行类构造器方法，把静态变量赋成代码里的值并运行静态代码块，父类先于子类，JVM 保证只执行一次。

实践：遇到 NoClassDefFoundError 或 NoSuchMethodError，先查是不是同一个类被两个 jar 加载了，用 -verbose:class 或 Arthas 确认。`,
    points: ["五个阶段各自做什么", "准备阶段赋零值的例外", "初始化只执行一次且线程安全"],
    follow: "解析为什么要延迟到运行时才做？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-jvm-parent-delegation",
    category: "backend",
    topic: "类加载",
    difficulty: 2,
    tags: ["双亲委派", "Tomcat", "SPI", "类加载器"],
    question: "Tomcat 为什么要打破双亲委派？还有哪些场景必须打破？",
    answer: `结论：双亲委派是收到加载请求先交给父加载器，加载不了才自己加载，用来避免重复加载并保护核心类库。打破它的场景有三类。

- Web 容器：Tomcat 一个进程跑多个应用，应用之间要隔离，且应用自己的类要优先于容器共享的类，所以 WebAppClassLoader 重写 loadClass，先加载 WEB-INF 下的类。
- SPI 场景：JDBC 的 Driver 接口由 Bootstrap 加载，实现类在应用 classpath 上，父加载器看不到，只能靠线程上下文类加载器加载。
- 热部署与模块化：OSGi 把树状委派改成网状，每个 Bundle 有自己的加载器；JSP 编译也属于这一类。

排查类冲突时先用 -verbose:class 或 Arthas 的 classloader 命令确认类到底是谁加载的。`,
    points: ["委派的流程与两个目的", "Tomcat 的隔离与优先加载", "SPI 用线程上下文加载器"],
    follow: "同一个类被两个加载器加载会发生什么？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-jvm-class-init-timing",
    category: "backend",
    topic: "类加载",
    difficulty: 2,
    tags: ["类初始化", "被动引用", "静态内部类", "单例"],
    question: "类什么时候才会被初始化？哪些引用属于被动引用？",
    answer: `结论：只有六种情况会触发初始化，其余引用都是被动引用，不会初始化。

- 遇到 new、getstatic、putstatic、invokestatic 四条指令，对应创建对象、读写静态字段、调用静态方法；new 数组不算。
- 用反射调用，Class.forName 默认会初始化，ClassLoader.loadClass 只加载不初始化。
- 初始化子类时先初始化父类，接口不要求先初始化父接口；启动时会初始化带 main 方法的主类。
- 通过 MethodHandle 或 invokedynamic 解析出的句柄对应的类。
- 接口定义了 default 方法时，实现类初始化会先初始化该接口。

三种典型被动引用：子类引用父类静态字段只初始化父类；定义数组只加载元素类；static final 常量在编译期进了调用方常量池，连定义类都不加载。静态内部类单例就是靠这一条懒加载。`,
    points: ["六种主动引用", "三种典型被动引用", "静态内部类单例的懒加载"],
    follow: "Class.forName 和 ClassLoader.loadClass 有什么区别？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-jvm-tuning-flags",
    category: "backend",
    topic: "JVM",
    difficulty: 2,
    tags: ["JVM 调优", "参数", "元空间", "GC 日志"],
    question: "线上 8G 的机器跑一个 Java 服务，JVM 参数你会怎么配？",
    answer: `结论：参数从业务形态倒推，先定堆和收集器，再补元空间、栈和直接内存。

- 堆：-Xms 与 -Xmx 设成相等，避免运行期扩缩容带来停顿；容器里更推荐用 -XX:MaxRAMPercentage 按 cgroup 限制算比例，别写死 -Xmx。
- 元空间与栈：元空间首次触发 GC 的阈值 -XX:MetaspaceSize 默认只有 20MB 左右，偏小会让启动期多几次 Full GC，可以设成 256m 并用 -XX:MaxMetaspaceSize 兜底；栈大小 -Xss 默认 1MB，几千线程时不能忽略。
- 直接内存：默认上限等于 -Xmx，用 Netty 这类堆外缓存多的组件时要单独限制。
- 观测与兜底：用 -Xlog:gc 开 GC 日志，并加上 -XX:+HeapDumpOnOutOfMemoryError 保留现场，出问题时才有堆快照可查。`,
    points: ["堆与容器感知参数", "元空间、栈、直接内存", "GC 日志与 dump 兜底"],
    follow: "为什么 -Xms 和 -Xmx 要设成一样大？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-jvm-memory-leak-oom",
    category: "backend",
    topic: "线上排查",
    difficulty: 3,
    tags: ["内存泄漏", "OOM", "MAT", "NMT"],
    question: "线上内存泄漏怎么排查？jstat、jmap、MAT、NMT 各看什么？",
    answer: `结论：先分清是堆内泄漏还是堆外泄漏，再决定用哪套工具。

- 粗判用 jstat：jstat -gcutil pid 1000 看老年代使用率，Full GC 后 O 列降不下来就是堆内泄漏；进程 RSS 一直涨而堆很稳，问题就在堆外。
- 堆内取证用 jmap 加 MAT：jmap -dump:live 导出堆快照会暂停应用，要避开高峰；在 MAT 里先看泄漏嫌疑，再用支配树找最大的对象，最后查它到 GC Roots 的路径并排除弱引用。
- 堆外取证用 NMT：启动加 NativeMemoryTracking 参数，再用 jcmd 的 native_memory 看元空间、线程栈哪块在涨。
- 常见根因：ThreadLocal 用完没清理、静态 Map 当缓存没有上限、监听器没注销、连接和流没关闭。

别在生产反复执行 jmap -histo:live，它会触发 Full GC。`,
    points: ["先分堆内还是堆外", "jmap 加 MAT 的取证顺序", "NMT 看堆外哪块在涨"],
    follow: "为什么 jmap 导出快照会影响线上服务？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-jvm-high-cpu-troubleshoot",
    category: "backend",
    topic: "线上排查",
    difficulty: 2,
    tags: ["CPU 飙高", "jstack", "火焰图", "Arthas"],
    question: "线上 CPU 使用率飙到 100%，你怎么定位到具体代码？",
    answer: `结论：按进程、线程、栈三步走，先找到最忙的线程，再看调用栈。

- 用 top 找到 java 进程的 PID，再用 top -Hp PID 按线程排序，记下最忙的 TID。
- 把 TID 转成十六进制，printf "%x\\n" TID，再 jstack PID 输出到文件，搜 nid 加那个十六进制值，就能拿到这个线程当时的栈。
- 看栈顶在做什么：业务代码里的死循环、正则回溯、大 JSON 序列化就改代码；如果是 GC 线程等 JVM 内部线程，转去看 jstat -gcutil 和 GC 日志。
- 更省事的是 Arthas：thread -n 3 列出最忙的三个线程栈，profiler start 配合 async-profiler 采火焰图，横向宽度就是采样占比，重点看最宽的栈顶。

还要分清是持续飙高还是周期性尖刺，后者多半是定时任务、日志刷盘或 GC。`,
    points: ["top 加 jstack 的标准三步", "区分业务线程与 GC 线程", "火焰图看最宽的栈顶"],
    follow: "jstack 里的 nid 为什么要转成十六进制？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-jvm-frequent-full-gc",
    category: "backend",
    topic: "线上排查",
    difficulty: 3,
    tags: ["Full GC", "jstat", "晋升失败", "System.gc"],
    question: "线上频繁 Full GC，你会怎么一步步定位？",
    answer: `结论：先量化频率和回收效果，再按内存泄漏、晋升过快、外部触发三类原因排除。

- 量化：jstat -gcutil pid 1000 看 FGC 增长和 FGCT 耗时，盯 O 列；Full GC 后老年代降不下去就是泄漏，dump 堆用 MAT 找支配树里最大的对象。
- 晋升过快：Survivor 太小或晋升阈值太低，对象没熬过几次 GC 就进老年代，可以调 SurvivorRatio 和晋升年龄阈值，G1 下还要看 Humongous 大对象是否太多。
- 外部触发：代码或框架显式调用 System.gc()，RMI 的分布式 GC 也会周期性触发，用 -XX:+DisableExplicitGC 挡掉。
- 取证：用 -Xlog:gc 开日志，看每次 Full GC 前后的老年代占用，确认原因再动参数。

先别急着加 -Xmx，它常常只是把泄漏暴露的时间往后推。`,
    points: ["用 jstat 量化频率与效果", "泄漏、晋升、显式调用三类", "先看 GC 日志再加堆"],
    follow: "System.gc() 在生产环境为什么很危险？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-jvm-escape-analysis",
    category: "backend",
    topic: "JVM",
    difficulty: 3,
    tags: ["逃逸分析", "栈上分配", "标量替换", "锁消除"],
    question: "什么是逃逸分析？栈上分配、标量替换、锁消除是怎么回事？",
    answer: `结论：逃逸分析是 JIT 在方法内联后做的分析，判断对象会不会逃出方法或线程，不逃逸才允许优化。

- 对象被方法外的代码引用叫方法逃逸，被其他线程访问叫线程逃逸，逃逸了就不能优化。
- 栈上分配：对象随栈帧出栈自动销毁，不需要 GC 介入。HotSpot 实际用标量替换实现，把对象拆成局部变量放进寄存器，由 -XX:+EliminateAllocations 控制，默认开启。
- 锁消除：锁对象不逃逸、不可能被其他线程竞争时同步块会被直接去掉，由 -XX:+EliminateLocks 控制，默认开启，循环里拼接字符串就是典型场景。
- 逃逸分析本身由 -XX:+DoEscapeAnalysis 控制，JDK 6u23 之后服务端默认开启。

要注意它依赖即时编译，解释执行阶段对象照样在堆上分配，刚启动时 GC 压力一点不少；也不能把对象身份的正确性押在它身上。`,
    points: ["方法逃逸与线程逃逸", "标量替换实现栈上分配", "依赖 JIT 且不能当语义保证"],
    follow: "为什么说 HotSpot 里其实没有真正的栈上分配？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-jvm-metaspace-leak",
    category: "backend",
    topic: "线上排查",
    difficulty: 3,
    tags: ["元空间", "永久代", "Metaspace", "类加载器泄漏"],
    question: "元空间和永久代有什么区别？线上元空间一直涨怎么排查？",
    answer: `结论：永久代是 JDK 8 之前方法区的实现，在堆内，受 -XX:MaxPermSize 限制；元空间从 JDK 8 起用本地内存，受 -XX:MaxMetaspaceSize 和物理内存约束。

- 元空间存类的元数据、字节码、常量池和注解，回收的前提是加载它的类加载器被回收，类加载器被谁挂住，元空间就一直涨。
- 常见根因是动态生成类：CGLIB 和 ASM 代理、JSP 编译、MyBatis 的 Mapper 代理；类加载器被静态字段或 ThreadLocal 持有也会让它无法回收。
- 排查：jstat -gcutil 看 M 列，启动加 NativeMemoryTracking 参数，再用 jcmd 的 native_memory 确认元空间是否在涨。
- 处置：把 -XX:MaxMetaspaceSize 设成兜底值，让问题尽早以元空间溢出暴露，而不是吃光内存被容器杀掉。`,
    points: ["堆内永久代与堆外元空间", "类加载器被持有导致泄漏", "NMT 与 jcmd 的定位方式"],
    follow: "为什么元空间的回收要看类加载器？",
    sources: [{ repo: "JavaGuide", path: "docs/java/jvm/" }, { repo: "athena", path: "doc/" }],
  },
];
