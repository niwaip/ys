import {
  riskTypes,
  riskTypeLabels,
  type RiskConfig,
  type RiskView,
} from "../../../../../packages/contracts/lifecycle-risk";
const categories = {
  all: "全部类别",
  server: "服务器",
  network: "网络设备",
  unknown: "未分类",
};
type Props = {
  config: RiskConfig;
  edit: (next: RiskConfig) => void;
  busy: boolean;
  preview?: { before: RiskView["summary"]; after: RiskView; changes: number };
  onPreview: () => void;
  onSave: () => void;
};
export function RiskConfigEditor({
  config,
  edit,
  busy,
  preview,
  onPreview,
  onSave,
}: Props) {
  function ruleEditor(
    rule: RiskConfig["defaultRule"],
    change: (r: RiskConfig["defaultRule"]) => void,
    prefix: string,
  ) {
    return (
      <div className="risk-form-grid">
        <label>
          <input
            aria-label={`${prefix}启用`}
            type="checkbox"
            checked={rule.enabled}
            onChange={(e) => change({ ...rule, enabled: e.target.checked })}
          />
          启用规则
        </label>
        <label>
          {prefix}提醒提前月数
          <input
            type="number"
            min="1"
            max="120"
            value={rule.reminderMonths}
            onChange={(e) =>
              change({ ...rule, reminderMonths: Number(e.target.value) })
            }
          />
        </label>
        <label>
          {prefix}警告提前月数
          <input
            type="number"
            min="0"
            max="120"
            value={rule.warningMonths}
            onChange={(e) =>
              change({ ...rule, warningMonths: Number(e.target.value) })
            }
          />
        </label>
        <p>到期当天起致命</p>
      </div>
    );
  }
  return (
    <section className="asset-panel">
      <h2>客户默认规则</h2>
      <p>
        类别规则优先于同风险类型的全部类别规则，其余使用客户默认。阈值按自然月计算，月底取目标月最后一天。
      </p>
      <fieldset disabled={busy}>
        <label>
          客户时区
          <input
            value={config.timeZone}
            onChange={(e) => edit({ ...config, timeZone: e.target.value })}
          />
        </label>
        {ruleEditor(
          config.defaultRule,
          (r) => edit({ ...config, defaultRule: r }),
          "默认",
        )}
        <h2>设备使用年限</h2>
        <p>
          不设置统一报废标准。空值表示未配置，缺少年限或购买日期显示待补资料。
        </p>
        <div className="risk-form-grid">
          {(["server", "network", "unknown"] as const).map((c) => (
            <label key={c}>
              {categories[c]}使用年限
              <input
                type="number"
                min="1"
                max="100"
                value={config.serviceYears[c] ?? ""}
                onChange={(e) =>
                  edit({
                    ...config,
                    serviceYears: {
                      ...config.serviceYears,
                      [c]: e.target.value ? Number(e.target.value) : null,
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
        <h2>类别覆盖规则</h2>
        {config.overrides.map((o, n) => (
          <fieldset key={n}>
            <legend>覆盖规则 {n + 1}</legend>
            <div className="risk-form-grid">
              <label>
                覆盖风险类型
                <select
                  value={o.type}
                  onChange={(e) =>
                    edit({
                      ...config,
                      overrides: config.overrides.map((v, j) =>
                        j === n
                          ? { ...v, type: e.target.value as typeof o.type }
                          : v,
                      ),
                    })
                  }
                >
                  {riskTypes.map((t) => (
                    <option value={t} key={t}>
                      {riskTypeLabels[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                覆盖设备类别
                <select
                  value={o.category}
                  onChange={(e) =>
                    edit({
                      ...config,
                      overrides: config.overrides.map((v, j) =>
                        j === n
                          ? {
                              ...v,
                              category: e.target.value as typeof o.category,
                            }
                          : v,
                      ),
                    })
                  }
                >
                  {Object.entries(categories).map(([k, v]) => (
                    <option value={k} key={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {ruleEditor(
              o.rule,
              (r) =>
                edit({
                  ...config,
                  overrides: config.overrides.map((v, j) =>
                    j === n ? { ...v, rule: r } : v,
                  ),
                }),
              `规则${n + 1}`,
            )}
            <button
              onClick={() =>
                edit({
                  ...config,
                  overrides: config.overrides.filter((_, j) => j !== n),
                })
              }
            >
              删除覆盖
            </button>
          </fieldset>
        ))}
        <button
          disabled={config.overrides.length >= 40}
          onClick={() =>
            edit({
              ...config,
              overrides: [
                ...config.overrides,
                {
                  type: "os_support",
                  category: "all",
                  rule: { ...config.defaultRule },
                },
              ],
            })
          }
        >
          添加覆盖规则
        </button>
      </fieldset>
      <div className="form-actions">
        <button className="primary" disabled={busy} onClick={onPreview}>
          预览影响
        </button>
      </div>
      {preview && (
        <section className="risk-preview">
          <h3>变更影响预览</h3>
          <p>
            {preview.changes} 项发生变化；风险项 {preview.before.riskItems} →{" "}
            {preview.after.summary.riskItems}；不评估{" "}
            {preview.before.unassessed} → {preview.after.summary.unassessed}
          </p>
          <button className="primary" disabled={busy} onClick={onSave}>
            确认保存规则
          </button>
        </section>
      )}
    </section>
  );
}
