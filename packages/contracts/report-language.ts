import type { ReportFacts } from "./reports";

/** A deliberately finite language, not a validator for arbitrary natural-language claims. */
export const narrationGrammar = {
  introductions: ["围绕", "针对", "结合"],
  explanations: [
    "本段说明所选输入",
    "请结合保护事实解读",
    "后续核查应保留来源依据",
  ],
  connectors: ["因此，", "接下来，", ""],
  actions: ["核对输入身份", "复核来源证据", "补充覆盖资料", "安排人工复评"],
  purposes: ["明确后续核查范围", "保留复核依据", "完善后续评估输入"],
  syntax:
    "说明句：<围绕|针对|结合>【引用】，<说明短语>。 建议句：<因此，|接下来，|空>建议<动作>，以便<目的>。多句可组合；每段建议须先有引用说明句。",
};
export type NarrationReference = {
  token: string;
  value: string;
  explanations: string[];
};
export function narrationReferences(facts: ReportFacts): NarrationReference[] {
  const refs: NarrationReference[] = [
    {
      token: "scope",
      explanations: narrationGrammar.explanations,
      value:
        facts.scope
          .map(
            (s) =>
              `${s.kind} ${s.name} / ${s.version ?? "未知"}（对象 ${s.objectId}，输入 ${s.versionId ?? "未知"}）`,
          )
          .join("；") || "未选对象输入",
    },
  ];
  if (facts.statistics.findingInstances !== null)
    refs.push({
      token: "findings",
      explanations: [
        ...narrationGrammar.explanations,
        "这些条目仅反映所选评估，不能证明运行实例受影响",
      ],
      value: `所选评估结果条目 ${facts.statistics.findingInstances}（不能等同确认受影响资产数）`,
    });
  if (facts.coverageIssues.length)
    refs.push({
      token: "coverage",
      explanations: [
        ...narrationGrammar.explanations,
        "这些缺口限制结果解释，需补充证据后复评",
      ],
      value: `覆盖缺口：${facts.coverageIssues.join("；")}`,
    });
  for (const a of facts.assessmentSnapshots)
    refs.push({
      explanations: narrationGrammar.explanations,
      token: `assessment:${a.id}`,
      value: `评估 ${a.id}，执行状态 ${a.status}，执行时间 ${a.finishedAt ?? "未知"}`,
    });
  for (const a of facts.lifecycleSnapshots)
    refs.push({
      explanations: narrationGrammar.explanations,
      token: `lifecycle:${a.id}`,
      value: `生命周期评估 ${a.id}，规则 ${a.ruleVersion}，评估时间 ${a.evaluatedAt}`,
    });
  return refs;
}

/** Parse complete sentences from finite productions, then resolve references from bound facts. */
export function resolveNarration(text: string, facts: ReportFacts): string {
  if (!text.trim()) return "";
  const refs = new Map(narrationReferences(facts).map((r) => [r.token, r]));
  const sentences = text.trim().split("。");
  if (sentences.pop() !== "") throw Error("叙述每句须以句号结束");
  const cited = new Set<string>();
  return sentences
    .map((raw) => {
      const sentence = raw.trim();
      for (const intro of narrationGrammar.introductions) {
        if (!sentence.startsWith(`${intro}【`)) continue;
        const end = sentence.indexOf("】，");
        const token = sentence.slice(intro.length + 1, end);
        const explanation = sentence.slice(end + 2);
        if (
          end < 0 ||
          !refs.has(token) ||
          !refs.get(token)!.explanations.includes(explanation)
        )
          throw Error("叙述引用不在当前事实目录或说明短语不符合语法");
        cited.add(token);
        return `${intro}${refs.get(token)!.value}，${explanation}。`;
      }
      for (const connector of narrationGrammar.connectors)
        for (const action of narrationGrammar.actions)
          for (const purpose of narrationGrammar.purposes)
            if (sentence === `${connector}建议${action}，以便${purpose}`) {
              if (!cited.size)
                throw Error("建议须先引用所选事实，不能脱离依据");
              if (action === "补充覆盖资料" && !cited.has("coverage"))
                throw Error("补充覆盖建议需要覆盖缺口证据");
              return `${sentence}。`;
            }
      throw Error(
        "叙述只接受目录中的引用说明句和建议句；不接受自写事实、判定、数字、日期或HTML",
      );
    })
    .join("");
}
