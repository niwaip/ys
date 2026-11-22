export const defaultSeverities = ["CRITICAL", "HIGH"];
export const severityOptions = [
  ["CRITICAL", "致命"],
  ["HIGH", "高危"],
  ["MEDIUM", "中危"],
  ["LOW", "低危"],
  ["UNKNOWN", "未知"],
] as const;
export function SeverityControls({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <fieldset className="severity-controls">
      <legend>结果关注等级（仅筛选显示）</legend>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
        {severityOptions.map(([id, label]) => (
          <label key={id}>
            <input
              type="checkbox"
              checked={value.includes(id)}
              onChange={(e) =>
                onChange(
                  severityOptions
                    .map(([s]) => s)
                    .filter((s) =>
                      s === id ? e.target.checked : value.includes(s),
                    ),
                )
              }
            />
            {label}
          </label>
        ))}
      </div>
      <p>
        默认关注高危与致命；仅筛选显示，完整记录保留，不自动确认或修改漏洞判定。
      </p>
    </fieldset>
  );
}
