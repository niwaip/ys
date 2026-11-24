import type { ReportPresentation } from "../../../../../packages/contracts/report-presentation";

export const defaultPresentation: ReportPresentation = {
  topic: "combined",
  optionalChapters: ["summary", "overview", "recommendations"],
};
export function ReportPresentationFields({
  value,
  onChange,
  disabled,
  prefix = "",
}: {
  value: ReportPresentation;
  onChange: (value: ReportPresentation) => void;
  disabled?: boolean;
  prefix?: string;
}) {
  return (
    <fieldset className="report-presentation" disabled={disabled}>
      <legend>{prefix}报告内容</legend>
      <label>
        报告专题
        <select
          aria-label={`${prefix}报告专题`}
          value={value.topic}
          onChange={(e) =>
            onChange({
              ...value,
              topic: e.target.value as ReportPresentation["topic"],
            })
          }
        >
          <option value="combined">综合风险报告</option>
          <option value="vulnerability">漏洞专题</option>
          <option value="lifecycle">生命周期专题</option>
        </select>
      </label>
      {(
        [
          ["summary", "管理摘要"],
          ["overview", "风险总览"],
          ["recommendations", "整改建议"],
        ] as const
      ).map(([key, label]) => (
        <label key={key}>
          <input
            type="checkbox"
            aria-label={`${prefix}${label}`}
            checked={value.optionalChapters.includes(key)}
            onChange={(e) =>
              onChange({
                ...value,
                optionalChapters: e.target.checked
                  ? [...value.optionalChapters, key]
                  : value.optionalChapters.filter((item) => item !== key),
              })
            }
          />
          {label}
        </label>
      ))}
      <p>
        范围、覆盖、未知与必要来源说明始终保留。历史对比需选择基准报告后启用。
      </p>
    </fieldset>
  );
}
