import { requestId } from "../../request-id";
import { useEffect, useRef, useState } from "react";
import type { FeatureProps } from "../../features";
import { api, ApiError } from "../../api";
import type {
  Software,
  SoftwareVersion,
} from "../../../../../packages/contracts/software";
import type {
  Assessment,
  AssessmentSummary,
  AnyAssessmentPage,
} from "../../../../../packages/contracts/assessments";
import type {
  SoftwareHistory,
  SoftwareComparison,
} from "../../../../../packages/contracts/software-history";
import {
  AssessmentDetails,
  assessmentStatusLabels,
} from "../assessments/AssessmentDetails";
import "../software/software.css";
const changeLabels = {
  added: "新增观察",
  persistent: "持续观察",
  not_observed: "本次未再观察到",
};
export function SoftwareHistoryPage({
  customerId,
  token,
  onUnauthorized,
}: FeatureProps) {
  const [software, setSoftware] = useState<Software[]>([]),
    [selected, setSelected] = useState(""),
    [history, setHistory] = useState<SoftwareHistory>(),
    [inputId, setInputId] = useState(""),
    [components, setComponents] = useState<SoftwareVersion>(),
    [batches, setBatches] = useState<{
      items: AssessmentSummary[];
      total: number;
      limit: number;
      offset: number;
    }>({ items: [], total: 0, limit: 20, offset: 0 }),
    [batch, setBatch] = useState<Assessment>(),
    [baselineId, setBaselineId] = useState(""),
    [comparedId, setComparedId] = useState(""),
    [comparison, setComparison] = useState<SoftwareComparison>(),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const controller = useRef(new AbortController()),
    objectId = useRef(""),
    versionOffset = useRef(0),
    batchOffset = useRef(0),
    requestKey = useRef<{ versionId: string; key: string } | undefined>(
      undefined,
    );
  const base = `/customers/${customerId}`;
  const call = <T,>(path: string, options: RequestInit = {}) =>
    api<T>(path, token, options, controller.current.signal);
  function fail(e: unknown) {
    if (controller.current.signal.aborted) return;
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  async function reload() {
    const id = objectId.current,
      vOffset = versionOffset.current,
      bOffset = batchOffset.current;
    if (!id) return;
    try {
      const [h, b] = await Promise.all([
        call<SoftwareHistory>(
          `${base}/software/${id}/history?limit=20&offset=${vOffset}`,
        ),
        call<AnyAssessmentPage>(
          `${base}/assessments?targetKind=software&targetId=${id}&limit=20&offset=${bOffset}`,
        ),
      ]);
      if (id !== objectId.current) return;
      if (vOffset === versionOffset.current) setHistory(h);
      if (bOffset === batchOffset.current)
        setBatches({
          ...b,
          items: b.items.filter(
            (j): j is AssessmentSummary => j.target.kind === "software",
          ),
        });
    } catch (e) {
      fail(e);
    }
  }
  useEffect(() => {
    controller.current = new AbortController();
    call<{ items: Software[] }>(`${base}/software`)
      .then((r) => setSoftware(r.items))
      .catch(fail);
    const timer = setInterval(reload, 1500);
    return () => {
      clearInterval(timer);
      controller.current.abort();
    };
  }, [customerId, token]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function choose(id: string) {
    objectId.current = id;
    setSelected(id);
    setHistory(undefined);
    setComponents(undefined);
    setBatch(undefined);
    setBaselineId("");
    setComparedId("");
    setComparison(undefined);
    setInputId("");
    versionOffset.current = 0;
    batchOffset.current = 0;
    requestKey.current = undefined;
    if (id) await reload();
  }
  async function compare(offset = 0) {
    if (!selected) return;
    setComparison(
      await call<SoftwareComparison>(
        `${base}/software/${selected}/history/compare`,
        {
          method: "POST",
          body: JSON.stringify({ baselineId, comparedId, limit: 20, offset }),
        },
      ),
    );
  }
  return (
    <section className="software-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">软件评估版本</p>
          <h1>历史与比较</h1>
          <p>
            分别选择当前纳管输入、评估批次和比较方向。历史不随新资料或重扫改写。
          </p>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <div className="panel">
        <label>
          历史软件对象
          <select
            value={selected}
            disabled={busy}
            onChange={(e) => run(() => choose(e.target.value))}
          >
            <option value="">选择软件对象</option>
            {software.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {history && (
        <>
          <div className="panel">
            <h2>当前纳管选择</h2>
            {history.current ? (
              <>
                <p>
                  当前输入：{history.current.version ?? "版本未知"} ·{" "}
                  {history.current.versionId}
                </p>
                <p>
                  当前批次：
                  {history.current.assessmentId ?? "未指定，不能视作已评估"}
                </p>
                <p>显式选择于 {history.current.selectedAt}</p>
              </>
            ) : (
              <p>尚未选择当前纳管版本；不自动使用最新输入或最近成功批次。</p>
            )}
            <h3>输入版本摘要 · {history.versions.total} 份资料</h3>
            <table>
              <thead>
                <tr>
                  <th>选择输入</th>
                  <th>版本及时间</th>
                  <th>来源与组件数</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {history.versions.items.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <input
                        type="radio"
                        name="history-input"
                        aria-label={`选择输入 ${v.version ?? "未知"} ${v.id.slice(0, 8)}`}
                        checked={inputId === v.id}
                        onChange={() => {
                          setInputId(v.id);
                          setComponents(undefined);
                          requestKey.current = undefined;
                        }}
                      />
                    </td>
                    <td>
                      {v.version ?? "未知"}
                      <p>{v.id}</p>
                      <p>{v.createdAt}</p>
                    </td>
                    <td>
                      {v.fileName}
                      <p>
                        {v.componentCount} 个组件 · 采集：
                        {v.collectedAt ?? "未知"}
                      </p>
                      <details>
                        <summary>资料校验信息</summary>
                        <p>{v.contentHash}</p>
                      </details>
                    </td>
                    <td>
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            setComponents(
                              await call<SoftwareVersion>(
                                `${base}/software/${selected}/versions/${v.id}`,
                              ),
                            );
                          })
                        }
                      >
                        组件与来源 {v.version ?? "未知"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              disabled={busy || history.versions.offset === 0}
              onClick={() => {
                versionOffset.current = Math.max(0, versionOffset.current - 20);
                reload();
              }}
            >
              上一页输入
            </button>
            <button
              disabled={
                busy || history.versions.offset + 20 >= history.versions.total
              }
              onClick={() => {
                versionOffset.current += 20;
                reload();
              }}
            >
              下一页输入
            </button>
            <div>
              <button
                disabled={busy || !inputId}
                onClick={() =>
                  run(async () => {
                    await call(`${base}/software/${selected}/history/current`, {
                      method: "PUT",
                      body: JSON.stringify({ versionId: inputId }),
                    });
                    await reload();
                    setMessage("当前输入已明确选择；当前评估批次未指定");
                  })
                }
              >
                设为当前输入
              </button>
              <button
                disabled={busy || !inputId}
                onClick={() =>
                  run(async () => {
                    if (
                      !requestKey.current ||
                      requestKey.current.versionId !== inputId
                    )
                      requestKey.current = {
                        versionId: inputId,
                        key: requestId(),
                      };
                    const job = await call<Assessment>(`${base}/assessments`, {
                      method: "POST",
                      body: JSON.stringify({
                        softwareId: selected,
                        versionId: inputId,
                        idempotencyKey: requestKey.current.key,
                      }),
                    });
                    requestKey.current = undefined;
                    setBatch(undefined);
                    batchOffset.current = 0;
                    await reload();
                    setMessage(`重扫已提交：${job.id}；当前纳管选择未改动`);
                  })
                }
              >
                重扫所选输入
              </button>
            </div>
          </div>
          <div className="panel">
            <h2>评估批次摘要 · {batches.total} 次</h2>
            <p>
              任务编号标识一次评估批次，输入版本标识其依据。请选择两个不同批次；可跨同一软件的输入版本比较。
            </p>
            <table>
              <thead>
                <tr>
                  <th>比较选择</th>
                  <th>任务与输入</th>
                  <th>状态 / 发现行数</th>
                  <th>查看与当前选择</th>
                </tr>
              </thead>
              <tbody>
                {batches.items.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <label>
                        <input
                          type="radio"
                          name="baseline"
                          aria-label={`基准批次 ${j.id.slice(0, 8)}`}
                          checked={baselineId === j.id}
                          onChange={() => {
                            setBaselineId(j.id);
                            setComparison(undefined);
                          }}
                        />
                        基准
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="compared"
                          aria-label={`对比批次 ${j.id.slice(0, 8)}`}
                          checked={comparedId === j.id}
                          onChange={() => {
                            setComparedId(j.id);
                            setComparison(undefined);
                          }}
                        />
                        对比
                      </label>
                    </td>
                    <td>
                      {j.id}
                      <p>
                        输入：{j.input.version ?? "未知"} · {j.target.versionId}
                      </p>
                      <p>{j.createdAt}</p>
                    </td>
                    <td>
                      {assessmentStatusLabels[j.status]}
                      <p>原始发现行：{j.findingCount ?? "未知"}</p>
                      <p>覆盖：{j.coverage?.status ?? "未知"}</p>
                    </td>
                    <td>
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            setBatch(
                              await call<Assessment>(
                                `${base}/software/${selected}/history/assessments/${j.id}`,
                              ),
                            );
                          })
                        }
                      >
                        查看批次 {j.id.slice(0, 8)}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await call(
                              `${base}/software/${selected}/history/current`,
                              {
                                method: "PUT",
                                body: JSON.stringify({
                                  versionId: j.target.versionId,
                                  assessmentId: j.id,
                                }),
                              },
                            );
                            await reload();
                            setMessage(
                              "当前纳管输入与批次已明确选择；失败或覆盖缺口仍保留",
                            );
                          })
                        }
                      >
                        设为当前批次 {j.id.slice(0, 8)}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              disabled={busy || batches.offset === 0}
              onClick={() => {
                batchOffset.current = Math.max(0, batchOffset.current - 20);
                reload();
              }}
            >
              上一页批次
            </button>
            <button
              disabled={busy || batches.offset + 20 >= batches.total}
              onClick={() => {
                batchOffset.current += 20;
                reload();
              }}
            >
              下一页批次
            </button>
            <div>
              <button
                disabled={
                  busy ||
                  !baselineId ||
                  !comparedId ||
                  baselineId === comparedId
                }
                onClick={() => run(() => compare())}
              >
                比较所选两批
              </button>
            </div>
          </div>
        </>
      )}
      {components && (
        <div className="panel">
          <h2>所选输入组件与来源</h2>
          <p>
            {components.id} · 来源资料：{components.importId}
          </p>
          <table>
            <thead>
              <tr>
                <th>组件</th>
                <th>版本</th>
                <th>身份</th>
              </tr>
            </thead>
            <tbody>
              {components.components.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.version ?? "未知"}</td>
                  <td>
                    {c.purl ?? "PURL未知"}
                    <p>{c.issues.join("；")}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {comparison && (
        <div className="panel">
          <h2>评估差异</h2>
          <p>
            {comparison.comparable
              ? "观察结果可比较"
              : "缺少有效结果，无法比较发现变化"}
          </p>
          <p>
            新增观察：{comparison.counts.added ?? "未知"} · 持续观察：
            {comparison.counts.persistent ?? "未知"} · 本次未再观察到：
            {comparison.counts.notObserved ?? "未知"}
          </p>
          <p>
            基准：{comparison.counts.baselineUnique ?? "未知"} 个实例 /{" "}
            {comparison.counts.baselineRaw ?? "未知"} 行；对比：
            {comparison.counts.comparedUnique ?? "未知"} 个实例 /{" "}
            {comparison.counts.comparedRaw ?? "未知"}{" "}
            行。重复原始行保留次数，不重复累计同一组件目标的漏洞实例。
          </p>
          {comparison.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
          <table>
            <thead>
              <tr>
                <th>依据</th>
                <th>基准批次</th>
                <th>对比批次</th>
              </tr>
            </thead>
            <tbody>
              {[
                [
                  "任务",
                  comparison.baseline.assessmentId,
                  comparison.compared.assessmentId,
                ],
                [
                  "输入版本",
                  `${comparison.baseline.version ?? "未知"} / ${comparison.baseline.versionId}`,
                  `${comparison.compared.version ?? "未知"} / ${comparison.compared.versionId}`,
                ],
                [
                  "完成时间",
                  comparison.baseline.finishedAt,
                  comparison.compared.finishedAt,
                ],
                [
                  "工具",
                  comparison.baseline.toolVersion,
                  comparison.compared.toolVersion,
                ],
                [
                  "库更新时间",
                  comparison.baseline.database?.updatedAt,
                  comparison.compared.database?.updatedAt,
                ],
                [
                  "库状态",
                  comparison.baseline.database?.freshness,
                  comparison.compared.database?.freshness,
                ],
                [
                  "覆盖",
                  comparison.baseline.coverage?.status,
                  comparison.compared.coverage?.status,
                ],
              ].map(([label, left, right]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>{left ?? "未知"}</td>
                  <td>{right ?? "未知"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            输入变化：{comparison.contextChanges.inputChanged ? "有" : "无"} ·
            工具变化：{comparison.contextChanges.toolChanged ? "有" : "无"} ·
            库变化：{comparison.contextChanges.databaseChanged ? "有" : "无"} ·
            覆盖变化：{comparison.contextChanges.coverageChanged ? "有" : "无"}
          </p>
          <table>
            <thead>
              <tr>
                <th>变化</th>
                <th>组件 / 漏洞 / 目标</th>
                <th>两侧观察</th>
              </tr>
            </thead>
            <tbody>
              {comparison.changes.items.map((c) => (
                <tr key={c.key}>
                  <td>{changeLabels[c.status]}</td>
                  <td>
                    <strong>{c.vulnerabilityId}</strong>
                    <p>
                      {c.packageName} · {c.ecosystem} · {c.target}
                    </p>
                  </td>
                  <td>
                    基准：{c.baseline?.occurrences ?? 0} 行，安装版本{" "}
                    {c.baseline?.installedVersions.join(", ") ?? "未观察到"}
                    <p>
                      对比：{c.compared?.occurrences ?? 0} 行，安装版本{" "}
                      {c.compared?.installedVersions.join(", ") ?? "未观察到"}
                    </p>
                    {c.identity === "unresolved" && (
                      <p>组件关联不足，不推断跨批次同一身份</p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            disabled={busy || comparison.changes.offset === 0}
            onClick={() =>
              run(() => compare(Math.max(0, comparison.changes.offset - 20)))
            }
          >
            上一页差异
          </button>
          <button
            disabled={
              busy || comparison.changes.offset + 20 >= comparison.changes.total
            }
            onClick={() => run(() => compare(comparison.changes.offset + 20))}
          >
            下一页差异
          </button>
        </div>
      )}
      {batch && <AssessmentDetails job={batch} />}
    </section>
  );
}
