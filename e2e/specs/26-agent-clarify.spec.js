// 运行前歧义预判 E2E：目标缺信息时，提示里要真的带上「先问清再动手」。
//
// 为什么值得单独一套：这一问是**并进**技能匹配那一次请求的（多一个往返不值当），
// 所以它最容易出的两个问题都只有端到端才看得见——
// 一次运行打了几次端点（并错了吗），以及结论有没有真的走到提示里（接线对了吗）。
// 断言读的是**桩收到的 prompt**，不是界面文案：那才回答「模型这次到底有没有被提醒」。
import { expect, test } from "@playwright/test";
import { aiCalls, final, mockAI, mockTypeSafe, runGoal, seedWithAI, TYPESAFE_SETTINGS } from "../helpers.js";

const GOAL = "把订单导出来给我看看";

/** 同一个端点可能被技能匹配、核验、歧义预判共用：按问句前缀分派回答。 */
function preflight({ ambiguous, blocker }) {
  return (body) => {
    const answers = {
      "gate::acts_on_data": { type: "noul", noul: 0.9 },
      "gate::follows_recorded_procedure": { type: "noul", noul: 0.9 },
      "gate::prose_suffices": { type: "noul", noul: 0.1 },
    };
    for (const id of Object.keys(body.questions)) {
      if (id === "clarify::ambiguous") answers[id] = { type: "noul", noul: ambiguous };
      else if (id === "clarify::blocker") answers[id] = { type: "choice", choice: blocker };
      else if (id.startsWith("applicable::")) answers[id] = { type: "noul", noul: 0.05 };
    }
    return { answers };
  };
}

async function promptOf(page) {
  const calls = await aiCalls(page);
  return calls.map((c) => String(c.messages?.at(-1)?.content ?? "")).join("\n");
}

async function start(page) {
  await mockAI(page, { responses: [final("已导出")] });
  await page.goto("/");
  await runGoal(page, GOAL);
  await expect(page.locator(".answer-card")).toContainText("已导出", { timeout: 20_000 });
}

test.describe("运行前歧义预判", () => {
  test("歧义达门槛：提示里带上「先问清再动手」与最可能缺的那一类", async ({ page }) => {
    test.setTimeout(60_000);
    await seedWithAI(page, TYPESAFE_SETTINGS);
    await mockTypeSafe(page, { answer: preflight({ ambiguous: 0.95, blocker: "time range" }) });
    await start(page);

    const prompt = await promptOf(page);
    expect(prompt).toContain("ask_user");
    expect(prompt).toContain("不要替用户假设");
    expect(prompt).toContain("time range");
  });

  test("没达门槛就不加话：被无端反问比猜错更赶人", async ({ page }) => {
    await seedWithAI(page, TYPESAFE_SETTINGS);
    await mockTypeSafe(page, { answer: preflight({ ambiguous: 0.2, blocker: "nothing beyond what is stated" }) });
    await start(page);
    expect(await promptOf(page)).not.toContain("不要替用户假设");
  });

  test("并进同一次请求：技能库为空时也只打一次端点", async ({ page }) => {
    const calls = [];
    await seedWithAI(page, TYPESAFE_SETTINGS);
    await mockTypeSafe(page, {
      answer: (body) => {
        calls.push(body);
        return preflight({ ambiguous: 0.95, blocker: "scope" })(body);
      },
    });
    // 三步运行：语义预判按运行只该问一次，而不是按步数重复
    await mockAI(page, { responses: [final("已导出")] });
    await page.goto("/");
    await runGoal(page, GOAL);
    await expect(page.locator(".answer-card")).toContainText("已导出", { timeout: 20_000 });

    expect(calls).toHaveLength(1);
    const ids = Object.keys(calls[0].questions);
    // 歧义两句与 gate 两句在同一次请求里（这才是不新增往返的含义）
    expect(ids.filter((id) => id.startsWith("clarify::"))).toHaveLength(2);
    expect(ids.filter((id) => id.startsWith("gate::"))).toHaveLength(3);
  });

  test("配置里关掉 clarify 后，请求不再带歧义问句", async ({ page }) => {
    const ids = [];
    await seedWithAI(page, { typesafe: { ...TYPESAFE_SETTINGS.typesafe, clarify: false } });
    await mockTypeSafe(page, {
      answer: (body) => {
        ids.push(...Object.keys(body.questions));
        return { answers: {} };
      },
    });
    await start(page);
    expect(ids.filter((id) => id.startsWith("clarify::"))).toHaveLength(0);
    expect(await promptOf(page)).not.toContain("不要替用户假设");
  });
});
