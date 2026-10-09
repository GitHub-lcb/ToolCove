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
    revision: 4,
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
        campaignId: { path: "campaigns", where: { claimStatus: "CLAIMABLE" }, pick: "campaignId" },
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
    label: "TRAE Work CN",
    enabled: true,
    builtin: true,
    revision: 2,
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
