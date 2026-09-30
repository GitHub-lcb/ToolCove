// 面试题库 · 后端 · MySQL 与存储。
// 本文件覆盖后端面试里的存储侧：执行计划与索引优化、事务与锁、日志与崩溃恢复、
// 在线 DDL、分库分表与主从复制、以及 Elasticsearch 的写入与同步，共 16 道。
// 与 interviewBankBackend.js 同属 backend 方向，只是把存储主题单独成文件，便于按主题维护。
// sources 只记录「来源仓库键 + 仓库内相对路径」，不写完整 URL：repo 限定为
// JavaGuide / advanced-java / CS-Notes / athena / bestJavaer 五个键，path 必须是该仓库
// 中真实存在的相对路径前缀，由 interviewBank.js 的 SOURCES 统一拼成可点开的链接。
// 注意：question / points / follow 中不要出现花括号，会破坏应用内的 i18n 消息编译。

export const BACKEND_MYSQL_QUESTIONS = [
  {
    id: "backend-mysql-explain-columns",
    category: "backend",
    topic: "索引与优化",
    difficulty: 2,
    tags: ["EXPLAIN", "执行计划", "type", "Extra"],
    question: "EXPLAIN 的 type、key、rows、Extra 这几列分别怎么读？",
    answer: `四个关键列要合起来读：type 是访问类型，key 是实际选中的索引，rows 是预估扫描行数，Extra 是补充信息。

- type 由好到坏：const、eq_ref、ref、range、index、ALL。核心 SQL 至少要到 ref，出现 ALL 或 index 就要警惕，index 表示扫整棵索引树，常常仍是全量扫描。
- key 为 NULL 说明没走索引；与 possible_keys 不一致，多是优化器算出回表代价高于全表扫。
- rows 是估算值，乘 filtered 才是真正参与 join 的行数，偏差大就用 analyze table 刷新统计信息。
- Extra 里 Using index 是覆盖索引，Using index condition 是索引下推，filesort 与 temporary 代价高，要靠索引消掉。

\`\`\`sql
explain select id from orders where user_id = 10 and status = 1;
\`\`\`

排查顺序：先看 type 和 key 定方向，再看 rows 与 filtered 是否合理，最后针对 Extra 里的 filesort 或 temporary 补索引。MySQL 8.0 还可以用 explain analyze 看每个算子的真实耗时。`,
    points: ["type 由好到坏的排序", "key 与 rows 反映优化器选择", "Extra 暴露排序与临时表"],
    follow: "possible_keys 有索引但 key 是 NULL，通常是什么原因？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-mysql-index-invalidation",
    category: "backend",
    topic: "索引与优化",
    difficulty: 1,
    tags: ["索引失效", "隐式类型转换", "最左前缀"],
    question: "哪些写法会导致索引失效？",
    answer: `本质是优化器用不上索引的有序性，或者判断走索引更贵。

- 索引列上套函数或运算：where date(created_at) = '2024-05-01' 用不上索引，改成 created_at >= '2024-05-01' and created_at < '2024-05-02' 就能走 range。
- 隐式类型转换：user_id 是 varchar 却写 where user_id = 100，会把列转成数字，等价于给列加函数；字符集不一致的 join 同理。
- 前导模糊：like '%abc' 定位不到起点，'abc%' 可以。
- or 连接了无索引的列，整条语句退化成全表扫，可以拆成两条再用 union all。
- 还有不满足最左前缀、范围条件截断后续列、区分度太低时优化器主动放弃。

联合索引必须从最左列开始连续匹配，范围条件之后的列在索引里就用不上了，只能回表后再筛。判断依据永远是 explain 的 key、rows 和 filtered，别凭感觉。`,
    points: ["函数包裹列等价于放弃有序性", "隐式类型转换与字符集不一致", "前导模糊和 or 导致全表扫"],
    follow: "字符串列存数字，为什么隐式转换会让索引失效？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-mysql-covering-index-icp",
    category: "backend",
    topic: "索引与优化",
    difficulty: 2,
    tags: ["回表", "覆盖索引", "索引下推"],
    question: "回表是什么？覆盖索引和索引下推怎么减少它的代价？",
    answer: `回表是走二级索引查到主键后，再回聚簇索引取整行的过程，一次查询可能带来大量随机 IO。

- 覆盖索引：查询要用的列都在索引里，直接从二级索引返回，Extra 显示 Using index。例如联合索引 (user_id, status, amount) 就能覆盖 select status, amount where user_id = 1。
- 索引下推 ICP：5.6 起，联合索引里被范围条件截断的列可以在存储引擎层先过滤再回表，Extra 显示 Using index condition。它减少的是回表次数，不是扫描行数。
- 实践：把 select * 换成只取需要的列，让高频查询走覆盖索引；Extra 同时出现 Using index condition 和 Using where，说明一部分条件下推、一部分留在 Server 层过滤。

代价也要算清楚：覆盖索引会让索引变宽，写入和存储成本都上升，只把高频查询真正需要的列放进去，不要为了省一次回表堆十几列。`,
    points: ["回表的随机 IO 代价", "覆盖索引让 Extra 显示 Using index", "ICP 减少回表次数而非扫描行数"],
    follow: "覆盖索引是不是列越多越好？会有什么代价？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-mysql-clustered-index-pk",
    category: "backend",
    topic: "索引与优化",
    difficulty: 1,
    tags: ["聚簇索引", "二级索引", "自增主键", "页分裂"],
    question: "聚簇索引和二级索引有什么区别？为什么推荐用自增主键？",
    answer: `聚簇索引按主键组织 B+ 树，叶子存整行数据，一张表只能有一个；二级索引的叶子存主键值，查非索引列必须回表。

推荐自增主键的原因：
- 自增插入永远追加到最右侧叶子，页分裂少、索引紧凑；UUID 这类随机值会插到中间，频繁页分裂产生碎片，写放大明显。
- 二级索引的叶子都存主键值，主键越长所有二级索引越大，所以用 bigint 而不是长字符串。
- 无序主键还会降低页填充率，让顺序扫描变慢。

实践：主键用 bigint unsigned auto_increment；分布式场景用雪花 ID，但要把时间戳放高位保证整体趋势递增；业务唯一键单独建唯一索引，不要拿它当主键。`,
    points: ["聚簇索引叶子存整行", "随机主键引发页分裂与碎片", "主键长度会放大所有二级索引"],
    follow: "雪花 ID 是趋势递增的，为什么它比 UUID 更适合做主键？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-mysql-isolation-levels",
    category: "backend",
    topic: "事务与锁",
    difficulty: 1,
    tags: ["隔离级别", "脏读", "不可重复读", "幻读"],
    question: "MySQL 的四个隔离级别分别解决了什么问题？",
    answer: `从低到高是读未提交、读已提交、可重复读、串行化，依次解决脏读、不可重复读、幻读。

- 读未提交：能读到别人没提交的修改，会脏读。
- 读已提交：只读已提交的数据，解决脏读；同一事务两次读同一行结果可能不同，即不可重复读。
- 可重复读：事务内复用同一个快照，解决不可重复读；这是 InnoDB 默认级别，快照读加间隙锁基本消除了幻读。
- 串行化：读加共享锁、写加排他锁，全串行，没有并发异常但吞吐最差。

机制上前三级靠 MVCC 提供快照读，串行化直接加锁。查看用 select @@transaction_isolation，修改用 set session transaction isolation level read committed。很多公司主动降到读已提交减少间隙锁冲突，但要同时把 binlog 格式设成 row。`,
    points: ["三类并发异常与级别的对应", "InnoDB 默认可重复读", "改级别要同步改 binlog 格式"],
    follow: "为什么把隔离级别降到读已提交就能减少锁冲突？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "backend-mysql-mvcc-readview",
    category: "backend",
    topic: "事务与锁",
    difficulty: 3,
    tags: ["MVCC", "ReadView", "undo log", "版本链"],
    question: "MVCC 是怎么实现的？ReadView 里有什么，可见性怎么判断？",
    answer: `MVCC 靠三样东西：隐藏字段、undo log 版本链、ReadView。

每行有 DB_TRX_ID 记录最后改它的事务 id，DB_ROLL_PTR 指向 undo log 里的上一个版本，多次修改串成版本链。ReadView 是快照读时生成的判断依据，含四部分：活跃事务 id 列表、最小活跃 id（低水位）、下一个待分配 id（高水位）、创建者自身 id。

可见性规则：行的 trx_id 小于低水位即可见；大于等于高水位不可见；落在区间内就看它在不在活跃列表里。不可见就沿 DB_ROLL_PTR 找上一个版本重新判断，直到可见或链走完。

读已提交每次 select 都重建 ReadView，所以能看到别人新提交的数据；可重复读只在第一次快照读时建，整个事务复用。当前读如 select for update、update、delete 会绕过 MVCC 读最新版本并加锁。`,
    points: ["隐藏字段与 undo log 版本链", "ReadView 的四个组成部分", "两种级别生成时机不同"],
    follow: "版本链越来越长会有什么问题？undo log 什么时候清理？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-mysql-lock-types-rules",
    category: "backend",
    topic: "事务与锁",
    difficulty: 2,
    tags: ["记录锁", "间隙锁", "临键锁", "意向锁"],
    question: "InnoDB 的锁有哪几种？加锁范围是由什么决定的？",
    answer: `按粒度分：记录锁锁单条索引记录；间隙锁锁两条记录之间的开区间；临键锁是记录锁加前面的间隙，是 RR 下的默认加锁单位；插入意向锁表示要在间隙里插入，与间隙锁互斥；意向共享锁和意向排他锁是表级标记，用来快速判断表里有没有行锁。

RR 下的加锁规则：
- 唯一索引等值命中只加记录锁，没命中退化为间隙锁。
- 非唯一索引等值命中会加临键锁加间隙锁，防止区间被插入。
- 范围查询对扫过的整个区间加临键锁。
- 没走索引时锁住全表记录和间隙，这是线上最危险的场景。

RC 下没有间隙锁，只有记录锁。查看锁等待用 performance_schema 的 data_locks 和 data_lock_waits 两张表。`,
    points: ["四种行锁与两种意向锁", "加锁范围取决于索引与条件", "没走索引会锁全表记录与间隙"],
    follow: "为什么两个事务可以同时持有同一个间隙的间隙锁？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "athena", path: "doc/" }],
  },
  {
    id: "backend-mysql-deadlock-diagnosis",
    category: "backend",
    topic: "事务与锁",
    difficulty: 3,
    tags: ["死锁", "死锁日志", "加锁顺序"],
    question: "线上遇到死锁怎么排查？死锁日志该看什么？",
    answer: `死锁是多个事务互相持有对方要的锁，形成循环等待，InnoDB 检测到后会回滚代价较小的一方。

常见成因：
- 加锁顺序不一致，两个事务按不同顺序更新同一批行。
- 间隙锁互相等待：两个事务在同一区间插入，各自持有间隙锁再申请插入意向锁。
- 走了非唯一索引的批量更新，锁范围比预期大。
- 大事务长时间持锁，并发一高就容易交叉。

排查用 show engine innodb status，看 LATEST DETECTED DEADLOCK 段：里面有两个事务的 trx id、正在执行的 SQL、各自持有的锁和等待的锁，重点比对两条 SQL 的加锁顺序与索引使用情况。

预防：按固定顺序更新、缩小事务范围、给条件列建合适索引、必要时降到读已提交减少间隙锁。`,
    points: ["死锁日志要对比两个事务的加锁顺序", "间隙锁与插入意向锁互相等待", "统一加锁顺序能规避多数死锁"],
    follow: "InnoDB 是怎么检测死锁的？检测到之后回滚哪个事务？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "backend-mysql-redo-undo-binlog",
    category: "backend",
    topic: "MySQL",
    difficulty: 3,
    tags: ["redo log", "undo log", "binlog", "两阶段提交"],
    question: "redo log、undo log、binlog 各管什么？为什么提交要两阶段？",
    answer: `分工：redo log 是 InnoDB 的物理日志，记录数据页的修改，循环写、容量固定，保证崩溃恢复的持久性；undo log 是逻辑日志，记录反向操作，支撑回滚和 MVCC 快照读；binlog 是 Server 层的逻辑日志，追加写，用于主从复制和时间点恢复。

两阶段提交的顺序是：写 redo log 并置为 prepare，写 binlog，再提交 redo log 置为 commit。顺序不能反，否则崩溃后两份日志不一致：
- prepare 后崩溃、binlog 没写，恢复时回滚该事务，主从都没有这次修改。
- binlog 写完、redo 还没 commit 时崩溃，恢复时发现 binlog 完整就提交，从库能重放。

redo log 用的是 WAL 思路：先顺序写日志再慢慢刷数据页，把随机写变成顺序写；组提交让多个事务共用一次刷盘，这是它能扛住高并发写入的原因。

sync_binlog = 1 配合 innodb_flush_log_at_trx_commit = 1 最安全，代价是每次提交刷两次盘。`,
    points: ["三种日志的层次与写入方式", "两阶段提交保证两份日志一致", "崩溃恢复靠 binlog 是否完整判定"],
    follow: "redo log 的刷盘时机由哪个参数控制？设成 0 会丢数据吗？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "bestJavaer", path: "docs/" }],
  },
  {
    id: "backend-mysql-slow-sql-workflow",
    category: "backend",
    topic: "索引与优化",
    difficulty: 2,
    tags: ["慢 SQL", "慢查询日志", "优化流程"],
    question: "线上有一条慢 SQL，你的定位和优化流程是什么？",
    answer: `流程是先定位 SQL，再分析执行计划，最后改写并验证。

- 定位：开慢查询日志，slow_query_log = on、long_query_time = 1，用 pt-query-digest 按总耗时排序；线上也可以查 performance_schema 的 digest 汇总表。
- 分析：对目标 SQL 做 explain，必要时 explain analyze 看真实耗时；关注 type 是否 ALL、rows 是否过大、Extra 有没有 filesort 和 temporary。
- 优化：优先补或改索引，让过滤、排序、分组都能用上索引；改写 SQL，避免 select * 和在索引列上做运算；深分页改延迟关联或游标；大事务拆小。
- 验证：对比上线前后的 rows、filtered 和慢日志平均耗时，别只在开发库的小数据量上验证。

还要区分是单条 SQL 慢还是整体并发高：前者改 SQL 和索引，后者多半是连接池、锁等待或机器资源的问题，结合 show processlist 和等待事件一起看。`,
    points: ["慢日志与 digest 表定位目标 SQL", "explain analyze 看真实耗时", "优化后要用真实数据量验证"],
    follow: "limit 100000, 10 这种深分页怎么优化？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "backend-mysql-online-ddl",
    category: "backend",
    topic: "MySQL",
    difficulty: 3,
    tags: ["在线 DDL", "元数据锁", "gh-ost", "大表变更"],
    question: "给千万级大表加字段或加索引，有哪些风险？怎么做才安全？",
    answer: `结论：加二级索引和加列支持 Online DDL，但大表仍不要在业务高峰直接执行。

- 加列：8.0 的 instant add column 只改数据字典，秒级完成；5.7 及以前要重建表，期间持有元数据锁，会阻塞写入。
- 加二级索引：默认 INPLACE，不阻塞 DML，但要全表扫描、消耗大量 IO，最后申请元数据锁的瞬间可能被长事务堵住，导致后面所有请求排队。
- 改列类型、改字符集、加主键一定重建表，代价最大。

实践：先确认没有长事务，DDL 等元数据锁会连锁堵住整张表；用 gh-ost 或 pt-online-schema-change 做影子表迁移，配合限流在低峰执行；设置 lock_wait_timeout 避免无限等待；结构变更与索引变更分开做，便于回滚。`,
    points: ["Online DDL 仍会在收尾阶段抢元数据锁", "长事务会把 DDL 变成全表阻塞", "影子表工具加限流是稳妥做法"],
    follow: "DDL 等待元数据锁时，为什么整张表的查询也会被堵住？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-mysql-shard-key-scale",
    category: "backend",
    topic: "分库分表",
    difficulty: 3,
    tags: ["分片键", "跨库查询", "扩容", "基因法"],
    question: "分片键怎么选？跨库查询和扩容的代价怎么控制？",
    answer: `分片键要同时满足：查询能带上它、数据分布均匀、跨片操作少。

常见选择：
- 按 user_id 取模或哈希，同一用户的数据落在同一片，用户维度查询最顺；按订单号查要靠映射表，或把 user_id 的低几位拼进订单号（基因法），让订单号自带分片信息。
- 按 order_id 取模写入均匀，但按用户查要扫全部分片。
- 按时间分表适合日志流水，新表写入集中会形成热点，通常再哈希二次打散。

跨库查询的代价：join 改成两次查询在应用层拼装；count、order by、分页要各分片执行后归并，深分页代价极高，一般改用游标。

扩容：取模分片最麻烦，常用两倍扩容加双写加数据校验迁移；更好的做法是一开始就预留分片位或用一致性哈希。分片后自增主键会冲突，要换成雪花 ID 之类的分布式 ID。`,
    points: ["分片键要均匀且尽量带在查询里", "跨片 join 与深分页代价最高", "取模扩容靠双写迁移或预留位"],
    follow: "基因法是怎么把分片信息藏进订单号的？",
    sources: [{ repo: "advanced-java", path: "docs/high-concurrency/" }, { repo: "JavaGuide", path: "docs/system-design/basis/" }],
  },
  {
    id: "backend-mysql-replication-lag",
    category: "backend",
    topic: "分库分表",
    difficulty: 2,
    tags: ["主从复制", "binlog", "复制延迟", "relay log"],
    question: "主从复制的原理是什么？主从延迟是怎么产生的？",
    answer: `原理：主库把修改写进 binlog，dump 线程推给从库；从库 IO 线程写入 relay log，SQL 线程回放 relay log 改数据。5.7 起支持多线程复制，按组提交或按库并行回放。

延迟成因：
- 主库写入并发高，从库回放跟不上，最常见。
- 大事务或大批量 DML，主库几秒、从库要回放很久。
- 从库承担大量查询，CPU 或磁盘打满。
- 表上没有主键或唯一键，row 格式下回放只能全表扫，一条 update 就能拖垮从库。

排查：show slave status 看 Seconds_Behind_Master，以及 Relay_Log_Pos 与 Read_Master_Log_Pos 的差值。

并行复制按组提交或按库分发，前提是主库用 row 格式且事务之间没有冲突，否则回放还是会退化成串行。

治理：拆小事务、给表补主键、开 slave_parallel_workers、给从库加资源、读请求按延迟路由，强一致读走主库。`,
    points: ["binlog 到 relay log 的两线程模型", "大事务与无主键表拖慢回放", "Seconds_Behind_Master 与位点差"],
    follow: "Seconds_Behind_Master 为 0 就一定没有延迟吗？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "advanced-java", path: "docs/high-concurrency/" }],
  },
  {
    id: "backend-mysql-read-write-consistency",
    category: "backend",
    topic: "MySQL",
    difficulty: 2,
    tags: ["读写分离", "主从延迟", "一致性", "会话粘性"],
    question: "读写分离之后，怎么保证刚写的数据一定能读到？",
    answer: `读写分离后写主库、读从库，复制延迟会让刚写入的数据读不到，这就是一致性问题。

按一致性要求分三档：
- 强一致读：写完立刻要读到的请求直接走主库，比如下单后跳订单详情。
- 会话粘性：同一会话在写入后一段时间内都读主库，把主库标记写进 session 或 cookie 并设 TTL，例如 1 秒。
- 最终一致：能接受秒级延迟的读走从库，配合缓存和前端异步刷新。

工程要点：用 ShardingSphere 这类中间件统一路由，避免业务代码里散落主从判断；监控 Seconds_Behind_Master，延迟超阈值自动把读切回主库；写后读场景尽量在业务层消除，写完直接返回完整对象给前端渲染。`,
    points: ["按一致性要求分档路由", "会话粘性用标记加 TTL", "延迟超阈值自动切回主库"],
    follow: "如果业务要求写完立刻读到，是不是干脆不要读写分离？",
    sources: [{ repo: "JavaGuide", path: "docs/database/mysql/" }, { repo: "advanced-java", path: "docs/distributed-system/" }],
  },
  {
    id: "backend-mysql-es-inverted-index",
    category: "backend",
    topic: "Elasticsearch",
    difficulty: 2,
    tags: ["ES", "倒排索引", "refresh", "translog"],
    question: "ES 的倒排索引是什么？一次写入到能被搜到经历了什么？",
    answer: `倒排索引是「词项到文档 id 列表」的映射：写入时先分词，建立 term dictionary 和 posting list，查询时按词项取集合求交并，所以全文检索比 like 快几个数量级。term 字典用 FST 压缩前缀，posting list 用增量编码和跳表加速求交。

写入流程：
- 数据先进内存缓冲区和 translog，translog 保证宕机不丢。
- refresh 默认每秒一次，把内存里的 segment 落到文件系统缓存并打开供搜索，所以是近实时，默认 1 秒可见。
- flush 在 translog 达到阈值（默认 512MB）或每 30 分钟触发，把 segment 落盘并清空 translog。
- segment 不可变，删除只是标记，靠后台 merge 合并并真正物理删除。

实践：批量导入用 bulk 并把 refresh_interval 设为 -1，导入完再恢复；refresh 越频繁 segment 越多，查询和 merge 压力越大。`,
    points: ["倒排索引与 term、posting list", "refresh 决定近实时的可见延迟", "flush 与 translog 保证不丢数据"],
    follow: "segment 为什么设计成不可变的？merge 会带来什么问题？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/basis/" }, { repo: "CS-Notes", path: "docs/" }],
  },
  {
    id: "backend-mysql-es-mysql-sync",
    category: "backend",
    topic: "Elasticsearch",
    difficulty: 2,
    tags: ["ES", "数据同步", "Canal", "binlog"],
    question: "MySQL 和 ES 之间怎么做数据同步？怎么保证不丢不改错？",
    answer: `常见四种方案：
- 双写：业务代码同时写 MySQL 和 ES，实现简单但两个系统没有事务，容易不一致，只适合容忍度高的场景。
- binlog 订阅：Canal 或 Debezium 伪装成从库解析 binlog，投递到 MQ 后由消费者写 ES，业务无侵入，生产上最常用。
- MQ 异步：写完 MySQL 发消息，消费者同步 ES，比双写可靠但仍可能丢消息。
- 定时全量加增量补偿：按更新时间字段定期扫表比对，作为兜底。

要点：同一文档的变更要保证顺序消费，可按文档 id 哈希到同一分区，否则旧值会覆盖新值；消费者用文档 id 做 upsert 保证幂等；定期全量或抽样比对，发现差异以 MySQL 为准重建；搜索场景一般容忍秒级延迟，要求强一致就说明不该拿 ES 做主查询。`,
    points: ["binlog 订阅是生产主流方案", "按文档 id 分区保证顺序", "upsert 幂等加定期比对兜底"],
    follow: "Canal 解析 binlog 时，怎么处理 DDL 和字段类型变更？",
    sources: [{ repo: "JavaGuide", path: "docs/system-design/basis/" }, { repo: "bestJavaer", path: "docs/" }],
  },
];
