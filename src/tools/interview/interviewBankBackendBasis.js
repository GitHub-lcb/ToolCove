// 面试题库 · 后端 · Java 基础与语言特性。
// 本文件是「面试刷题」工具的离线题库数据源之一，只导出 BACKEND_BASIS_QUESTIONS 一个常量数组，
// 不依赖任何运行时、不发网络请求，由 UI 层按 topic 分组、按 difficulty 排序、按 tags 检索。
// 内容覆盖 Java 基础、泛型、异常、IO 与 NIO、Java 新特性五个主题共 16 道题，
// 偏重语言机制与真实踩坑点，而不是 API 背诵。
// 来源归属约定：每条 sources 只写「仓库 key + 仓库内相对路径前缀」，用于标注知识出处，不写完整 URL，
// 由 UI 侧拼回仓库深链；repo 限定为 JavaGuide / advanced-java / CS-Notes / athena / bestJavaer 五个键，
// path 必须是该仓库中真实存在的相对路径前缀。新增题目请沿用同一约定。
// 注意：question / points / follow 中不要出现花括号，会破坏应用内的 i18n 消息编译（answer 的代码块内不受限）。

export const BACKEND_BASIS_QUESTIONS = [
  {
    id: "backend-basis-string-pool",
    category: "backend",
    topic: "Java 基础",
    difficulty: 1,
    tags: ["String", "字符串常量池", "intern"],
    question: "String 为什么设计成不可变的？字符串常量池和 intern 是怎么回事？",
    answer: `结论：String 内部用 final 修饰的 byte 数组保存内容（JDK 9 之前是 char 数组），对外不提供任何修改方法，所以不可变；字面量会进字符串常量池复用。

机制：
- 不可变换来三个好处：能安全地做常量池复用、hashCode 可以缓存在 hash 字段里只算一次、多线程共享不需要加锁。
- 字符串常量池在 JDK 7 从永久代挪到了堆里，所以它现在受 -Xmx 约束，不再算元空间的一部分。
- 字面量直接指向常量池对象，new String 会先在常量池确保内容存在，再在堆上新建一个对象，所以它和字面量用 == 比是 false。
- intern 会把字符串登记进常量池：JDK 7 起常量池在堆中，登记的是堆对象的引用，不再复制字符串。

实践：循环里拼字符串用 StringBuilder，编译器只优化字面量的常量折叠；用 intern 做大批量去重要谨慎，常量池的登记和查找本身就有成本，池子越大收益越低，优先用本地 Map 缓存。`,
    points: ["不可变的三个好处", "常量池 JDK 7 移到堆中", "字面量与 new 的 == 差异"],
    follow: "String、StringBuilder、StringBuffer 分别在什么场景下用？",
    sources: [{ repo: "JavaGuide", path: "docs/java/basis/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-basis-equals-hashcode-contract",
    category: "backend",
    topic: "Java 基础",
    difficulty: 1,
    tags: ["equals", "hashCode", "HashMap", "去重"],
    question: "为什么重写 equals 必须重写 hashCode？只重写一个会出什么问题？",
    answer: `结论：契约要求 equals 判定相等的两个对象 hashCode 必须相等。只重写 equals 会让哈希集合出现「存进去取不出来」和去重失效。

机制：
- Object 默认的 equals 比较引用，hashCode 是本地实现，一般与对象地址相关。
- 重写 equals 改成按业务字段比较后，两个内容相同的对象哈希值依然不同。HashMap 先用 hash 定位数组下标，下标都算错了，后面的 equals 比较根本不会发生。
- 反过来 hashCode 相同而 equals 不同只是哈希冲突，用链表或红黑树解决，所以 hashCode 只要求尽量分散，不要求唯一。

实践：参与 equals 比较的字段必须都参与 hashCode，可用 Objects.hash 或 IDE 生成；这些字段不能可变，元素放进 HashSet 之后再改字段，同样会找不到。排查去重失效和 get 返回 null 时，先检查这两个方法。`,
    points: ["equals 相等则 hashCode 必须相等", "哈希集合先按 hash 定位下标", "参与比较的字段必须一致"],
    follow: "把对象放进 HashSet 之后再修改参与 hashCode 的字段，会发生什么？",
    sources: [{ repo: "JavaGuide", path: "docs/java/basis/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-basis-pass-by-value",
    category: "backend",
    topic: "Java 基础",
    difficulty: 1,
    tags: ["值传递", "引用传递", "参数传递"],
    question: "Java 是值传递还是引用传递？为什么 swap 方法交换不了两个对象？",
    answer: `结论：Java 只有值传递。方法拿到的是实参值的副本，对象参数传的是引用的副本，所以能改对象内容，改不了调用方变量的指向。

机制：
- 基本类型复制的是数值本身，方法内怎么改都不影响外部。
- 对象类型复制的是引用地址，形参和实参指向同一个堆对象，通过形参调 setter 会生效；但把形参重新赋值成新对象，只是让副本指向别处。
- swap 交换的是两个副本里的地址，方法一返回副本就销毁，外部两个变量毫无变化。
- 数组和集合也是对象，道理一样：改元素生效，重新赋值不生效。

实践：需要返回多个值时返回对象、数组或容器，不要指望出参；想让方法修改外部状态只能靠成员变量或返回值。String 和包装类不可变，方法内拼接、自增看不到效果，最容易让人误以为是引用传递。`,
    points: ["Java 只有值传递", "对象传的是引用的副本", "重新赋值不影响调用方"],
    follow: "在方法里把传入的 List 清空，调用方能看到吗，为什么？",
    sources: [{ repo: "JavaGuide", path: "docs/java/basis/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-basis-boxing-cache",
    category: "backend",
    topic: "Java 基础",
    difficulty: 2,
    tags: ["自动装箱", "Integer 缓存", "空指针"],
    question: "Integer 用 == 比较为什么有时 true 有时 false？自动装箱有哪些坑？",
    answer: `结论：包装类的 == 比较的是引用，只有缓存区间内的值才复用同一个对象，所以 127 相等、128 不等，比较值必须用 equals。

机制：
- Integer.valueOf 在 -128 到 127 之间直接返回 IntegerCache 里的对象，上界可以用 -XX:AutoBoxCacheMax 调大；Byte、Short、Long 同样缓存这个区间，Character 缓存 0 到 127，Float 和 Double 不缓存。
- 装箱发生在赋值、传参和集合 add 时，拆箱发生在算术运算和比较时，混用会不断创建临时对象。

\`\`\`java
Integer a = 127, b = 127;   // true，走缓存
Integer c = 128, d = 128;   // false，各自新建
\`\`\`

实践：实体字段和返回值用包装类（能表达 null），局部变量用基本类型；三元表达式两边一个是包装类一个是基本类型时会触发拆箱，值为 null 就抛 NullPointerException，这是线上最常见的一类空指针。`,
    points: ["== 比引用，equals 比值", "缓存区间是 -128 到 127", "拆箱遇到 null 抛空指针"],
    follow: "三元表达式里包装类和基本类型混用，什么情况下会抛空指针？",
    sources: [{ repo: "JavaGuide", path: "docs/java/basis/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-basis-bigdecimal-precision",
    category: "backend",
    topic: "Java 基础",
    difficulty: 2,
    tags: ["BigDecimal", "浮点数", "金额计算"],
    question: "为什么 0.1 加 0.2 不等于 0.3？金额计算应该怎么处理？",
    answer: `结论：float 和 double 是二进制浮点，0.1 这类十进制小数无法用有限位二进制精确表示，只能存最接近的近似值，所以 0.1 加 0.2 得到 0.30000000000000004。金额必须用 BigDecimal。

机制：
- 比较 BigDecimal 要用 compareTo，equals 会连 scale 一起比，2.0 和 2.00 判为不等。
- 除法必须指定 scale 和 RoundingMode，否则除不尽时抛 ArithmeticException；HALF_UP 是四舍五入，HALF_EVEN 是银行家舍入。
- BigDecimal 不可变，每次运算都产生新对象，循环里累加要留意开销。

实践：构造用字符串或 BigDecimal.valueOf，不要用 new BigDecimal(0.1)，后者会把 double 的误差原样带进来；数据库 decimal 字段查出来直接用，中途不要转 double；对外输出统一 setScale，避免前端看到多余精度。`,
    points: ["二进制浮点存不下十进制小数", "比较用 compareTo 而非 equals", "除法必须指定精度与舍入"],
    follow: "HALF_UP 和 HALF_EVEN 有什么区别，银行场景通常用哪个？",
    sources: [{ repo: "JavaGuide", path: "docs/java/basis/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-basis-final-finally-finalize",
    category: "backend",
    topic: "Java 基础",
    difficulty: 1,
    tags: ["final", "finally", "finalize"],
    question: "final、finally、finalize 分别是什么？各自用在什么场景？",
    answer: `结论：三个词没有关系。final 是修饰符，finally 是异常处理的收尾块，finalize 是 Object 上已被废弃的回收前回调。

机制：
- final 修饰类表示不可被继承，修饰方法表示不可被重写，修饰字段表示只能赋值一次；修饰引用类型只保证引用不变，对象内容照样能改。
- finally 在 try 块退出时执行，常用来关资源。如果 try 里执行了 System.exit，或线程被杀掉，finally 不会执行；在 finally 里 return 会覆盖 try 的返回值并吞掉异常，属于必须避免的写法。
- finalize 由 GC 在回收前调用，执行时机不确定甚至可能不执行，还会让对象多活一轮，JDK 9 起标记废弃，JDK 18 起可用 --finalization=disabled 关闭。

实践：资源关闭统一用 try-with-resources，不要依赖 finalize 做清理；确实需要收尾逻辑就实现 AutoCloseable 或使用 Cleaner。`,
    points: ["final 修饰类方法字段的语义", "finally 会执行但有例外", "finalize 已废弃且时机不确定"],
    follow: "try 里 return、finally 里也 return，最终返回的是哪个值？",
    sources: [{ repo: "JavaGuide", path: "docs/java/basis/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-basis-generics-erasure-pecs",
    category: "backend",
    topic: "泛型",
    difficulty: 3,
    tags: ["泛型擦除", "PECS", "通配符", "桥接方法"],
    question: "泛型擦除是什么？extends 和 super 通配符该怎么选？",
    answer: `结论：泛型只活在编译期，编译后类型参数被擦成它的上界（无界就是 Object），运行时拿不到 List<String> 里装的到底是什么；通配符的选择记 PECS：生产者用 extends，消费者用 super。

机制：
- 擦除带来的限制：不能 new T、不能 new T 数组、不能对泛型做 instanceof，静态成员不能用类型参数，重写泛型方法时编译器会生成桥接方法保证多态。
- List<String> 与 List<Object> 之间没有继承关系，所以 List<String> 不能赋给 List<Object>，加上通配符才有协变效果。
- 读取用 extends：元素至少是上界的子类型，能安全读成上界；写入用 super：容器至少能装下下界类型，能安全写入。

\`\`\`java
static <T> void copy(List<? extends T> src, List<? super T> dst)
\`\`\`

实践：集合参数优先声明成 Collection，确实要写入才用 super；需要运行时泛型信息就显式传 Class 或 TypeReference，Jackson、Gson 反序列化就是这么做的。`,
    points: ["编译期擦除成上界", "PECS 生产者 extends 消费者 super", "擦除导致不能 new T 与 instanceof"],
    follow: "既然泛型被擦除了，MyBatis 和 Jackson 是怎么拿到泛型类型的？",
    sources: [{ repo: "JavaGuide", path: "docs/java/basis/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-basis-overload-override-bridge",
    category: "backend",
    topic: "泛型",
    difficulty: 2,
    tags: ["重载", "重写", "桥接方法", "动态分派"],
    question: "重载和重写有什么区别？重写泛型方法为什么会多出桥接方法？",
    answer: `结论：重载是同一个类里方法名相同、参数列表不同，编译期按参数的静态类型选定；重写是子类覆盖父类方法，签名必须一致，运行期按实际类型动态分派。

机制：
- 重载只看参数的静态类型，所以传 null 或基本类型与包装类混用时，可能调用到意料之外的那个方法；返回值不同不构成重载。
- 重写的约束是两同两小一大：方法名和参数相同，返回值和抛出的异常不能变大，访问权限不能变小；private、static、final 方法和构造器都不能被重写。
- 泛型重写时类型参数被擦除，子类方法擦除后的签名和父类不一致，编译器会生成一个桥接方法去调用真正的方法，保证多态生效，反射里因此会看到一个多出来的方法。

实践：重写一律加 @Override，签名写错时编译器直接报错，而不是悄悄变成重载；桥接方法只在看字节码或反射结果时才会碰到，正常开发不用管。`,
    points: ["重载编译期绑定、重写运行期分派", "重写要满足两同两小一大", "擦除后编译器生成桥接方法"],
    follow: "为什么说重载是静态绑定，而重写是动态绑定？",
    sources: [{ repo: "JavaGuide", path: "docs/java/basis/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-basis-interface-vs-abstract",
    category: "backend",
    topic: "泛型",
    difficulty: 2,
    tags: ["接口", "抽象类", "默认方法", "骨架实现"],
    question: "接口和抽象类该怎么选？为什么集合框架用接口加泛型来设计？",
    answer: `结论：抽象类表达「是什么」，用来复用状态和实现；接口表达「能做什么」，用来定义能力契约。Java 是单继承多实现，所以优先用接口定契约，确实要共享字段和代码时才用抽象类。

机制：
- 抽象类可以有构造器、成员变量和任意访问权限的方法；接口的字段隐式是 public static final，方法默认 public abstract，JDK 8 起才有 default 和 static 方法，JDK 9 又加了 private 方法。
- 集合框架的套路是接口定契约（List、Map），抽象类做骨架实现（AbstractList），具体类只补少量方法；泛型把元素类型交给调用方决定，既避免强转又能在编译期查类型。
- 接口多了默认方法后会出现菱形继承冲突，编译器强制要求显式重写并指定用哪个父接口的实现。

实践：领域模型中的可变状态放抽象类，跨模块的能力（Serializable、Comparable）用接口；给框架留扩展点时先出接口，再用抽象类兜底，降低使用者的实现成本。`,
    points: ["抽象类复用状态，接口定义契约", "默认方法带来菱形冲突", "接口加骨架抽象类的套路"],
    follow: "两个接口的 default 方法冲突时，编译器要求你怎么解决？",
    sources: [{ repo: "JavaGuide", path: "docs/java/basis/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-basis-exception-try-with-resources",
    category: "backend",
    topic: "异常",
    difficulty: 2,
    tags: ["异常体系", "try-with-resources", "受检异常"],
    question: "说说 Java 的异常体系，try-with-resources 解决了什么问题？",
    answer: `结论：Throwable 分 Error 和 Exception，Exception 又分受检异常和 RuntimeException。受检异常必须显式处理，运行时异常不强制；try-with-resources 让实现了 AutoCloseable 的资源在块结束时自动关闭，按声明的逆序关闭。

机制：
- Error 是虚拟机层面的问题，如 OutOfMemoryError、StackOverflowError，应用一般无力恢复；RuntimeException 如 NullPointerException、IllegalArgumentException 多是编码问题。
- try-with-resources 编译后会生成 finally 里的 close 调用，并用 addSuppressed 把 close 抛出的异常挂在主异常上，不会像手写 finally 那样把真正的业务异常覆盖掉。
- 多个资源按声明顺序的逆序关闭，所以有依赖关系时，被依赖的资源要写在前面、后关闭。

\`\`\`java
try (InputStream in = new FileInputStream(path)) {
    // 退出时自动 close，异常被压制而非覆盖
}
\`\`\`

实践：catch 里不要只打日志不处理，也不要 catch Throwable；自定义业务异常继承 RuntimeException，避免污染每一层的方法签名。`,
    points: ["Error 与 Exception 的区别", "受检异常必须显式处理", "资源按声明逆序自动关闭"],
    follow: "try-with-resources 里 close 也抛异常时，最终抛出的是哪一个？",
    sources: [{ repo: "JavaGuide", path: "docs/java/basis/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-basis-dynamic-proxy-exception",
    category: "backend",
    topic: "异常",
    difficulty: 3,
    tags: ["动态代理", "反射", "InvocationHandler", "异常包装"],
    question: "JDK 动态代理和 CGLIB 有什么区别？代理方法抛异常为什么会被包装？",
    answer: `结论：JDK 动态代理基于接口，用 Proxy 加 InvocationHandler 生成实现类；CGLIB 基于继承，用 ASM 生成子类，所以 final 类和方法代理不了。JDK 代理只能原样抛出接口上声明过的受检异常，没声明的会被包成 UndeclaredThrowableException。

机制：
- 代理对象调用时先进 invoke 方法，事务、日志、鉴权都在这里织入；反射调用 Method.invoke 抛出的 InvocationTargetException 必须用 getCause 拆开，才能拿到业务真实异常。
- 目标方法抛的受检异常不在接口方法的 throws 列表里时，代理没法原样抛出，只能包装；Spring AOP 遇到这种情况同样会包成 UndeclaredThrowableException。
- 反射调用有方法查找和参数装箱的开销，热点路径上可以缓存 Method，或用 MethodHandle 提升性能。

实践：排查代理相关异常先逐层 getCause 拆包，否则日志里全是包装异常；想让自定义异常穿透，就定义成 RuntimeException，或在接口方法上显式声明；final 类需要增强时改用接口抽象或 ByteBuddy。`,
    points: ["JDK 代理基于接口、CGLIB 基于继承", "InvocationTargetException 要拆包", "未声明的受检异常会被包装"],
    follow: "Spring 事务方法里抛受检异常为什么默认不回滚？",
    sources: [{ repo: "JavaGuide", path: "docs/java/basis/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-basis-java8-lambda-stream",
    category: "backend",
    topic: "Java 新特性",
    difficulty: 1,
    tags: ["Lambda", "Stream", "Optional", "函数式接口"],
    question: "Java 8 有哪些常用新特性？Stream 的惰性求值怎么理解？",
    answer: `结论：主要四块：Lambda 与函数式接口、Stream、Optional、接口默认方法，另外还有新的日期时间 API。Stream 的中间操作是惰性的，只有遇到终止操作才真正执行。

机制：
- 函数式接口只有一个抽象方法，Function、Consumer、Supplier、Predicate 最常用，方法引用是 Lambda 的简写。
- Stream 分中间操作（filter、map、sorted）和终止操作（collect、forEach、reduce），中间操作只是记录流水线，终止操作才触发一次遍历；一个 Stream 只能消费一次，重复用抛 IllegalStateException。
- Optional 用来表达可能为空，推荐 orElse、map、ifPresent，不要直接 get；它不适合做字段和参数，序列化也会出问题。

实践：集合批量处理用 Stream，但别在流里做远程调用；并行流默认用公共 ForkJoinPool，IO 密集或任务不均衡时反而更慢；需要顺序、下标或复杂控制流时，老老实实写 for 循环更好维护。`,
    points: ["四大函数式接口与方法引用", "中间操作惰性、终止操作触发", "Optional 表达空值别用 get"],
    follow: "parallelStream 在什么情况下会比普通 for 循环更慢？",
    sources: [{ repo: "JavaGuide", path: "docs/java/new-features/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-basis-java17-21-features",
    category: "backend",
    topic: "Java 新特性",
    difficulty: 2,
    tags: ["记录类", "密封类", "模式匹配", "虚拟线程"],
    question: "Java 17 到 21 有哪些值得关注的新特性？虚拟线程解决什么问题？",
    answer: `结论：语言层面是记录类、密封类、instanceof 与 switch 的模式匹配、文本块；运行时层面是分代 ZGC 和 Java 21 正式转正的虚拟线程。

机制：
- record 自动生成构造器、访问器、equals、hashCode 和 toString，适合做 DTO 和值对象；字段隐式 final，不能继承其他类。
- sealed 用 permits 限定子类范围，配合 record 和模式匹配可以把类型判断写成穷尽的 switch，漏掉分支编译期就报错。
- 虚拟线程由 JVM 调度，遇到阻塞 IO 会自动从载体线程上卸载，所以能用同步写法拿到异步的吞吐，适合 IO 密集场景；CPU 密集任务仍应用平台线程。

实践：8 升 17 要先处理模块化带来的问题，Java EE 相关包在 11 已移除，sun.misc.Unsafe 部分方法被弃用；虚拟线程不要塞进线程池，也别在 synchronized 块里做长阻塞（会钉住载体线程），改用 ReentrantLock。`,
    points: ["record 适合做值对象", "sealed 配合模式匹配做穷尽检查", "虚拟线程适合 IO 密集场景"],
    follow: "虚拟线程为什么不能放进线程池，和平台线程使用上有什么区别？",
    sources: [{ repo: "JavaGuide", path: "docs/java/new-features/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-basis-io-models-zero-copy",
    category: "backend",
    topic: "IO 与 NIO",
    difficulty: 3,
    tags: ["BIO", "NIO", "零拷贝", "多路复用"],
    question: "BIO、NIO、AIO 有什么区别？零拷贝是怎么减少数据拷贝的？",
    answer: `结论：BIO 是一连接一线程的同步阻塞模型，NIO 是同步非阻塞加多路复用，AIO 是异步回调。零拷贝并不是不拷贝，而是省掉内核缓冲区与用户缓冲区之间的来回拷贝。

机制：
- NIO 的三个核心是 Channel、Buffer、Selector，一个 Selector 能管理大量连接，用就绪事件替代轮询，Netty 就是在这个基础上做的。
- 传统「读文件再写 socket」要四次拷贝、四次上下文切换；sendfile 让数据在内核里直接从文件到网卡，mmap 把文件映射到用户空间省掉一次拷贝，Java 里对应 FileChannel.transferTo。
- AIO 在 Linux 上底层仍是 epoll 加线程池模拟，回调也难调试，实际使用远少于 NIO。

实践：连接数多、单条消息小的场景用 NIO；连接数少、每条连接数据量大时 BIO 反而更简单高效。用 transferTo 传大文件，注意单次最多传 2G，超过要分段循环。`,
    points: ["BIO 阻塞、NIO 多路复用、AIO 回调", "零拷贝省掉用户态那两次拷贝", "Selector 与 Channel、Buffer"],
    follow: "Netty 为什么不用 AIO，而是选择 NIO 加多路复用？",
    sources: [{ repo: "JavaGuide", path: "docs/java/io/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "backend-basis-spi-serviceloader",
    category: "backend",
    topic: "IO 与 NIO",
    difficulty: 2,
    tags: ["SPI", "ServiceLoader", "类加载", "JDBC"],
    question: "SPI 机制是怎么工作的？为什么 JDBC 驱动不用手动加载？",
    answer: `结论：SPI 是「接口在调用方、实现在扩展方」的解耦方式。约定是在 classpath 的 META-INF/services 目录放一个以接口全限定名命名的文件，内容是实现类全限定名，ServiceLoader 负责读取并实例化。

机制：
- ServiceLoader.load 会扫描所有 jar 里的 META-INF/services 文件，用线程上下文类加载器加载实现类，这正好打破了双亲委派：接口由 Bootstrap 加载，实现类却在应用的 classpath 上。
- JDBC 4 之后驱动 jar 里带了 java.sql.Driver 的配置文件，所以 Class.forName 可以省掉；MySQL 8 的驱动类是 com.mysql.cj.jdbc.Driver。
- 原生 SPI 只能遍历全部实现，不能按名取用，也没有依赖注入，Dubbo 因此做了改进版：用键值对配置，支持按名加载和 IOC、AOP。

实践：扩展点优先考虑 SPI；META-INF/services 没打进包时 ServiceLoader 不报错，只是遍历不到实现，文件里的类名写错则在遍历时抛 ServiceConfigurationError，排查顺序是先看配置文件在不在，再看类能否被当前类加载器加载。`,
    points: ["META-INF/services 的约定文件", "用线程上下文类加载器打破委派", "Dubbo SPI 支持按名加载"],
    follow: "ServiceLoader 找不到实现时为什么不报错，你一般怎么排查？",
    sources: [{ repo: "JavaGuide", path: "docs/java/basis/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-basis-shallow-deep-copy",
    category: "backend",
    topic: "IO 与 NIO",
    difficulty: 2,
    tags: ["深拷贝", "浅拷贝", "序列化", "clone"],
    question: "浅拷贝和深拷贝有什么区别？深拷贝有哪几种实现方式？",
    answer: `结论：浅拷贝只复制对象本身，引用字段仍指向同一个对象；深拷贝会递归复制所有引用对象，两份数据完全独立。Object.clone 默认就是浅拷贝。

机制：
- clone 的约定是调用 super.clone 拿到字段级复制，但类必须实现 Cloneable，否则抛 CloneNotSupportedException；引用字段要逐个再 clone 才够深，层级一深很容易漏。
- 序列化方式把对象写成字节再读回来，天然递归、不用逐字段处理，前提是所有字段可序列化，transient 字段会丢，性能也明显更差。
- 另外两种常见做法：手写拷贝构造器或静态工厂，语义最清晰；用 JSON 序列化转换，代价是类型信息可能丢失，日期和 BigDecimal 的精度尤其容易出问题。

实践：DTO 转换优先用拷贝构造器或 MapStruct；不要为了省事给可变对象实现 Cloneable，clone 会绕过构造器，final 字段和不变式容易被破坏。`,
    points: ["浅拷贝共享引用字段", "clone 默认浅拷贝且需 Cloneable", "序列化深拷贝的代价与限制"],
    follow: "为什么说 clone 会绕过构造器，可能破坏对象的不变式？",
    sources: [{ repo: "JavaGuide", path: "docs/java/io/" }, { repo: "CS-Notes", path: "docs/" }],
  },
];
