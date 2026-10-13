// 内置站点：随工具一起发布，开箱就有，不需要用户配置、也不需要抓包。
//
// 为什么要有这一层：站点描述这套机制的前提是「接口契约还没定」，所以把一切交给用户填。
// 但对 Qoder 这种我们自己天天用的客户端，让用户去抓包抄一个会过期的 token，
// 等于把无人值守的工具做成了每天要人喂一次的东西。内置掉它。
//
// 注意 CN 与国际版是**两个不同的东西**：域名不同（qoder.com.cn / qoder.sh）、
// 应用数据目录不同、登录态也不通用。这里内置的是 **Qoder CN**。
// 以后要加国际版就再开一条 builtin（换 key、换 baseUrl、换 credentialSource），
// 不要让它去扫另一个版本的凭据目录——拿错 token 的表现是 401，排查起来很费劲。
//
// 合并语义（loadSites 每次读取时做）：
// - 列表里没有这个 key → 补上；
// - 有、且是内置条目、但版本比代码里的旧 → 用代码这份，只保留用户的启用开关；
// - 有、且是用户自己加的（builtin 不为 true）→ 完全不动。
// 之所以要版本比对：用户一旦在界面上拨一下启用开关，内置条目就会被写进存储；
// 不做升级的话，那份就会被永久钉死在旧接口路径上，而接口路径恰恰是最可能改的东西。
export const BUILTIN_SITES = [
  {
    key: "qoder-cn",
    label: "Qoder CN",
    enabled: true,
    builtin: true,
    // 5 = pathFrom 的 campaignId 加 optional：实测 campaigns 非空但没有 CLAIMABLE
    // （数组里是 VIEW_DETAILS）时，原来会被报成「描述无效」。
    revision: 5,
    baseUrl: "https://openapi.qoder.com.cn",
    // 不存任何凭据：每次请求前由 credentialSource 当场读 Qoder CN 自己的登录态。
    credentialSource: "qoder-cn-local",
    // Cosy-ClientType 是**必需**的，不是可选的客户端标识：不带它，接口会正常返回 200，
    // 但 campaigns 是空数组、showCampaign 是 false——看起来就像「今天没有活动」。
    // 实测（10 是 Qoder 桌面端的 clientType）：
    //   只带 Authorization → {"showCampaign":false,"campaigns":[]}
    //   带 Cosy-ClientType → {"showCampaign":true,"claimable":true,"campaigns":[{...CLAIMABLE}]}
    status: { method: "GET", path: "/sash/api/v1/me/campaigns", headers: [["Cosy-ClientType", "10"]] },
    checkin: {
      method: "POST",
      path: "/sash/api/v1/me/campaigns/${campaignId}/claim",
      headers: [["Cosy-ClientType", "10"]],
      pathFrom: {
        campaignId: { path: "campaigns", where: { claimStatus: "CLAIMABLE" }, pick: "campaignId", optional: true },
      },
    },
    read: {
      // 两个响应的形状完全不一样，而 read 只有一份，所以按顺序给两条规则：
      //   查状态   → { campaigns: [{ actionType, claimStatus: "CLAIMABLE" | "CLAIMED" }] }
      //   执行签到 → { status: "CLAIMED" }   ← 签到页源码以此判定成功，不是 200 就行
      // 只填后一条的话，「今天已经领过了」会被读成「取不到状态」，接着 pathFrom 因为没有
      // CLAIMABLE 而失败，界面显示成「描述无效」——领成功了反而被骂配置写错。
      // 只填前一条则反过来：真领成功了也读不出来，当天不推进 lastDay，会重复发 claim。
      //
      // 第一条同时按 actionType 收窄，是为了不把「别的活动早已领过」误判成「今天已签」：
      // 实测 campaigns 里会同时存在 CLAIM_BENEFIT 与 VIEW_DETAILS 两种活动。
      checkedIn: [
        { path: "campaigns", where: { actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMED" }, pick: "claimStatus" },
        "status",
      ],
      // 顶层汇总布尔 claimable 不能当幂等依据：实测它在明明可领的时候给出 false，
      // 照它判会静默漏签一整天。真正准确的只有活动自己的 claimStatus。
      points: "",
      message: "",
      code: "",
      successCodes: null,
    },
  },
  {
    key: "trae-cn",
    label: "TRAE CN",
    enabled: true,
    builtin: true,
    // 2 = 显示名从「TRAE Work CN」改成「TRAE CN」。key 故意不动：它是内部标识，
    // 一改就要迁移存量签到记录（见 store.js 的 RENAMED_SITE_KEYS），
    // 而用户看到的只是 label，没必要为一次改名冒这个险。
    revision: 3,
    // host 也存在 TRAE 自己的凭据里（实测 https://api.trae.cn）。这里写死是因为描述需要一个
    // 固定的 baseUrl；真要换域名，改这里和改 credentialSource 是同一件事。
    baseUrl: "https://api.trae.cn",
    credentialSource: "trae-cn-local",
    // 两个动作都是 POST，且都要求 req_source：**2 = TRAE Work/lite，1 = TRAE IDE**。
    // 填错不报错，只会拿不到活动，所以两处必须一起改。
    status: { method: "POST", path: "/trae/api/v2/ug/checkin_credits/status", headers: [], body: '{"req_source":2}' },
    checkin: { method: "POST", path: "/trae/api/v2/ug/checkin_credits/claim", headers: [], body: '{"req_source":2}' },
    read: {
      // 实测（只读打了一次 status）：
      //   {"checked_in":false,"code":0,"credits":100,"enable":true,"extra_credits":100,"message":"success"}
      // 所以 checked_in 就是「今天签了没」，code=0 是业务成功——两个都配上，
      // 免得 HTTP 200 但业务失败时被当成签到成功。
      checkedIn: "checked_in",
      points: "",
      message: "message",
      code: "code",
      // 0 是成功码；toTriState(0) 会把 0 读成 false，所以这里必须靠 successCodes 判，
      // 不能把 code 当已签字段用。
      successCodes: [0],
      // 9074 的文案是「当前参与用户太多，请稍后再试」，但**它不代表账号被限流**——
      // 我们第一次拿到它是因为把整条 aha JSON 记录当成设备号发出去了（服务端对坏请求
      // 也只回这一句通用文案）。保留这个映射的理由是：既然它的语义就是「稍后再试」，
      // 按限流退避（30 分钟）永远比按失败重试安全，连发只会让惩罚窗口变长。
      rateLimitCodes: [9074],
    },
  },
  {
    key: "workbuddy-cn",
    label: "WorkBuddy CN",
    enabled: true,
    builtin: true,
    revision: 1,
    baseUrl: "https://www.workbuddy.cn",
    credentialSource: "workbuddy-cn-local",
    // 两个动作都是 POST + 空 JSON 对象（`{}`，不是空 body）。
    // 端点取自 WorkBuddy 桌面端 app.asar 自身：
    //   AuthService.getCheckinStatus()  → /v2/billing/meter/checkin-activity-status
    //   AuthService.claimDailyCheckin() → /v2/billing/meter/daily-checkin
    // 注意别用 Web/console 端的 /billing/meter/checkin-status（少 "-activity"）：
    // 那个在桌面端账号上恒返回 active:false、today_checked_in:false，
    // 看起来像「活动没开」，实际会把每一次签到都静默判成「无需签到」。
    status: { method: "POST", path: "/v2/billing/meter/checkin-activity-status", headers: [], body: "{}" },
    checkin: { method: "POST", path: "/v2/billing/meter/daily-checkin", headers: [], body: "{}" },
    read: {
      // 两个响应的形状**完全不同**，一份 read 只能按顺序试：
      //   查状态 → data.today_checked_in 是权威布尔值（data.active 只表示活动是否开放）
      //   执行签到 → data 里只有 {credit, streak_days, is_streak_day}，**根本没有** today_checked_in
      // 所以：布尔字段负责查状态，checkedInPresence 负责签到响应。
      //
      // 刻意**不**把 data.active 当 checkedIn 的兜底：active 的语义是「活动开着」，
      // 不是「今天签过」。一旦接口哪天不再下发 today_checked_in，兜底就会把
      // active:true 读成「已签到」并跳过当天——那是静默漏签，比报错难发现得多。
      checkedIn: "data.today_checked_in",
      checkedInPresence: "data.credit",
      // 签到响应里本次到账的积分（实测 100）。查状态那条没有 credit 字段
      // （它给的是 daily_credit / today_credit / total_credits），所以这里读不到就是没有。
      points: "data.credit",
      message: "msg",
      code: "code",
      // 0 是业务成功码；code 是数字，用 successCodes 才能把 0 正确判成成功
      // （toTriState(0) 会读成 false，所以不能让 code 兼任已签字段）。
      successCodes: [0],
      // 重复签到：HTTP 400 + {"code":10001,"msg":"今天已签到，请明天再来"}。
      // 实测服务端返回的就是 10001，而 app 自己的错误映射函数只列了 1001/1002/1003
      // （落到 UnknownBizError）——所以以实测码为准，同时也把 1001 认下来。
      alreadyCodes: [10001, 1001],
    },
  },
  {
    key: "qoder-ai",
    label: "Qoder AI",
    enabled: true,
    builtin: true,
    // 4 = 2026-10-13 实测发现国际版 campaigns 端点**按 umid 机器身份门控**：
    // 缺 Cosy-MachineToken/Code/Type 三个头时不报错，只回常驻的 VIEW_DETAILS 横幅，
    // 表现与「今天没有活动」一模一样。带上之后当轮的 CLAIMABLE 活动就出现了（并实测领到 100 Credits）。
    // 这三个头由 credentialSource 提供，不是静态 header——它们与本机绑定且会变。
    revision: 4,
    // 国际版与 CN 版**共用同一套 campaigns 接口与同一套响应结构**（实测：
    // 两边都是 {showCampaign, claimable, campaigns:[{campaignId, actionType, claimStatus}]}），
    // 差的只有基址与登录态。所以这里照搬 CN 那份描述，只换 baseUrl 与 credentialSource。
    //
    // 基址 `openapi.qoder.sh` 是**试出来的**：IDE bundle 里的 `api.qoder.com` /
    // `qoder.com` 用真实 token 实测都是 401（前者 TOKEN_INVALID，后者要 cookie），
    // 只有 openapi.qoder.sh 两个端点都返回 200。
    baseUrl: "https://openapi.qoder.sh",
    credentialSource: "qoder-intl-local",
    // Cosy-ClientType 与 CN 一样是 10（客户端里那段是写死的 clientType:10，
    // 不是 IDE 版本号 —— 我先前误从别处取了个 "qoder-ide"，那是另一个组件的参数）。
    status: { method: "GET", path: "/sash/api/v1/me/campaigns", headers: [["Cosy-ClientType", "10"]] },
    checkin: {
      method: "POST",
      path: "/sash/api/v1/me/campaigns/${campaignId}/claim",
      headers: [["Cosy-ClientType", "10"]],
      pathFrom: {
        // optional：挑 CLAIMABLE 挑不到时，报「今天没有可领的活动」而不是「描述无效」。
        // 这不是可选的礼貌——实测国际版 campaigns 里常年有一个 VIEW_DETAILS 活动
        // （actionType 不是 CLAIM_BENEFIT），数组非空但永远没有 CLAIMABLE。
        // 不开这个标志的话，这条内置站点**每一天**都会被判成「描述无效」，
        // 而描述本身一个字都没错。CN 版也有同样的形状，同样受益。
        campaignId: { path: "campaigns", where: { actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMABLE" }, pick: "campaignId", optional: true },
      },
    },
    read: {
      // 与 CN 完全相同：活动自己的 claimStatus 才是「今天签了没」的权威字段。
      // 顶层 claimable 实测在明明可领时会给 false（国际版这台机今天就是
      // showCampaign:true 却 claimable:false），照它判会静默漏签一整天。
      checkedIn: [
        { path: "campaigns", where: { actionType: "CLAIM_BENEFIT", claimStatus: "CLAIMED" }, pick: "claimStatus" },
        "status",
      ],
      points: "",
      message: "",
      code: "",
      successCodes: null,
    },
  },
];

/** 把内置站点并进用户列表；同名但非内置的条目原样保留。 */
export function mergeBuiltinSites(sites) {
  const list = Array.isArray(sites) ? sites : [];
  const out = list.slice();
  for (const builtin of BUILTIN_SITES) {
    const at = out.findIndex((site) => String(site?.key || "") === builtin.key);
    if (at < 0) {
      out.push(builtin);
      continue;
    }
    const stored = out[at];
    if (stored.builtin && Number(stored.revision) < builtin.revision) {
      out[at] = { ...builtin, enabled: stored.enabled !== false };
    }
  }
  return out;
}
