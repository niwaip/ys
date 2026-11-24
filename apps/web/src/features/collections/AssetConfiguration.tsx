import { downloadSoftwareComponentScript } from "./software-component-script";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import { requestId } from "../../request-id";
import type { FeatureProps } from "../../features";
import {
  collectionContents,
  collectionConfiguration,
  type CollectionConfiguration,
  type ConfigurationContent,
  type ConfigurationRun,
} from "../../../../../packages/contracts/collection-configuration";
import type { DeviceCategory } from "../../../../../packages/contracts/device-collection";
import { AssetBaseline } from "./AssetBaseline";
export type SubmittedObservation = {
  snapshotId: string;
  content: ConfigurationContent;
  eventId: string;
};
const states: Record<string, string> = {
  submitting: "提交中",
  queued: "排队中",
  running: "采集中",
  succeeded: "采集完成",
  awaiting_input: "等待脚本结果或手动输入",
  partial: "部分取得",
  failed: "失败",
  interrupted: "已中断",
  timed_out: "超时",
};
export function AssetConfiguration({
  category,
  platform,
  active,
  submittedObservation,
  onContent,
  onMethod,
  onRestore,
  ...props
}: FeatureProps & {
  category: DeviceCategory;
  platform: "linux" | "windows";
  active: ConfigurationContent;
  submittedObservation?: SubmittedObservation;
  onContent: (v: ConfigurationContent) => void;
  onMethod: (v: string) => void;
  onRestore: (v: CollectionConfiguration) => void;
}) {
  const { assetId, customerId, token, onUnauthorized } = props;
  const base = `/customers/${customerId}/collections`;
  const initial: CollectionConfiguration = {
    category,
    platform,
    items: Object.keys(collectionContents).map((content) => ({
      content: content as ConfigurationContent,
      enabled: content === "basic",
      method:
        content === "software"
          ? "manual"
          : ["server", "vm"].includes(category) && platform === "linux"
            ? "automatic"
            : "script",
    })),
  };
  const [config, setConfig] = useState(initial),
    [profiles, setProfiles] = useState<
      { id: string; label: string; assetId: string; scopes: string[] }[]
    >([]),
    [runs, setRuns] = useState<ConfigurationRun[]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [revision, setRevision] = useState(0);
  const key = useRef(requestId());
  const stop = useRef(false);
  const awaiting = useRef<
    | {
        runId: string;
        content: ConfigurationContent;
        previous?: string;
      }
    | undefined
  >(undefined);
  function fail(e: unknown) {
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  useEffect(() => {
    stop.current = false;
    const c = new AbortController();
    Promise.all([
      api<CollectionConfiguration | null>(
        `${base}/configurations/${assetId}`,
        token,
        {},
        c.signal,
      ),
      api<{ items: typeof profiles }>(`${base}/profiles`, token, {}, c.signal),
    ])
      .then(([saved, p]) => {
        if (c.signal.aborted) return;
        setProfiles(p.items.filter((p) => p.assetId === assetId));
        const parsed = collectionConfiguration.safeParse(saved);
        if (parsed.success) {
          setConfig({
            ...parsed.data,
            items: initial.items.map(
              (item) =>
                parsed.data.items.find((v) => v.content === item.content) ?? {
                  ...item,
                  enabled: false,
                },
            ),
          });
          onRestore(parsed.data);
        } else {
          setConfig((c) => ({
            ...c,
            items: c.items.map((item) => ({
              ...item,
              profileId: p.items.find(
                (v) =>
                  v.assetId === assetId &&
                  (item.content !== "docker" ||
                    v.scopes.includes("container-inventory")),
              )?.id,
            })),
          }));
        }
        setLoaded(true);
      })
      .catch((e) => {
        if (!c.signal.aborted) fail(e);
      });
    return () => {
      stop.current = true;
      c.abort();
    };
  }, [base, token, assetId]);
  useEffect(() => {
    if (awaiting.current && awaiting.current.content !== active)
      awaiting.current = undefined;
  }, [active]);
  useEffect(() => {
    const host = ["server", "vm"].includes(category);
    setConfig((c) => ({
      ...c,
      category,
      platform,
      items: c.items.map((item) => ({
        ...item,
        enabled:
          item.enabled &&
          (item.content === "basic" || host) &&
          (item.content !== "docker" || platform === "linux"),
        method:
          item.method === "automatic" && (!host || platform !== "linux")
            ? "script"
            : item.method,
      })),
    }));
  }, [category, platform]);
  useEffect(() => {
    const c = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const v = await api<{ items: ConfigurationRun[] }>(
          `${base}/configurations/${assetId}/runs`,
          token,
          {},
          c.signal,
        );
        if (!c.signal.aborted) setRuns(v.items);
      } catch (e) {
        if (!c.signal.aborted) fail(e);
      }
      if (!c.signal.aborted) timer = setTimeout(load, 2000);
    }
    void load();
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [base, token, assetId, revision]);
  useEffect(() => {
    const pending = awaiting.current;
    if (
      !pending ||
      !submittedObservation ||
      pending.previous === submittedObservation.eventId ||
      pending.content !== submittedObservation.content
    )
      return;
    awaiting.current = undefined;
    const c = new AbortController();
    api(
      `${base}/configuration-runs/${pending.runId}/result`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          content: pending.content,
          snapshotId: submittedObservation.snapshotId,
        }),
      },
      c.signal,
    )
      .then(() => {
        if (!c.signal.aborted) setRevision((v) => v + 1);
      })
      .catch((e) => {
        if (!c.signal.aborted) fail(e);
      });
    return () => c.abort();
  }, [submittedObservation?.eventId, base, token]);
  const host = ["server", "vm"].includes(category);
  function update(
    content: ConfigurationContent,
    value: Partial<CollectionConfiguration["items"][number]>,
  ) {
    setConfig((c) => ({
      ...c,
      items: c.items.map((i) =>
        i.content === content ? { ...i, ...value } : i,
      ),
    }));
    key.current = requestId();
    setNotice("配置已修改，请保存");
  }
  async function save(run = false) {
    setBusy(true);
    setError("");
    try {
      await api(`${base}/configurations/${assetId}`, token, {
        method: "POST",
        body: JSON.stringify(config),
      });
      if (stop.current) return;
      if (run) {
        await api(`${base}/configurations/${assetId}/run`, token, {
          method: "POST",
          body: JSON.stringify({
            idempotencyKey: key.current,
            configuration: config,
          }),
        });
        if (stop.current) return;
        setNotice("批次已保存：自动项已提交，脚本和手动项等待输入");
        setRevision((v) => v + 1);
        key.current = requestId();
      } else setNotice("采集配置已保存，可刷新重复使用");
    } catch (e) {
      if (!stop.current) fail(e);
    } finally {
      if (!stop.current) setBusy(false);
    }
  }
  async function adopt() {
    setBusy(true);
    setError("");
    let n = 0;
    try {
      for (const snapshotId of selected) {
        const preview = await api<{
          current: { id: string } | null;
          review?: { status: string };
          sections: Record<string, { comparable: boolean }>;
        }>(
          `/customers/${customerId}/assets/${assetId}/baseline?snapshotId=${snapshotId}`,
          token,
        );
        if (stop.current) return;
        const sections = Object.entries(preview.sections)
          .filter(([, s]) => s.comparable)
          .map(([k]) => k);
        if (!sections.length) continue;
        const r = await api<{ status: string }>(
          `/customers/${customerId}/assets/${assetId}/baseline/confirm`,
          token,
          {
            method: "POST",
            body: JSON.stringify({
              snapshotId,
              expectedBaselineId: preview.current?.id ?? null,
              sections,
              excludeFields: [],
              writeMasterData: false,
              idempotencyKey: requestId(),
            }),
          },
        );
        if (r.status !== "confirmed")
          throw Error("资料确认未完成，请查看分项详情");
        n++;
      }
      setNotice(`已采纳${n}项；未触发风险评估`);
      setSelected([]);
      setRevision((v) => v + 1);
    } catch (e) {
      if (!stop.current) {
        setError(`已完成${n}项；${(e as Error).message}`);
      }
    } finally {
      if (!stop.current) setBusy(false);
    }
  }
  const renderRun = (run: ConfigurationRun, latest = false) => (
    <article key={run.id} className="configuration-run">
      <strong>{new Date(run.createdAt).toLocaleString()}</strong>
      {run.items.map((item) => (
        <div key={item.content}>
          <p>
            {collectionContents[item.content]} ·{" "}
            {states[item.status] ?? item.status}
            {item.error ? `：${item.error}` : ""}
          </p>
          {item.snapshotId && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(item.snapshotId)}
                  onChange={(e) =>
                    setSelected((s) =>
                      e.target.checked
                        ? [...new Set([...s, item.snapshotId!])]
                        : s.filter((id) => id !== item.snapshotId),
                    )
                  }
                />
                选中此结果
              </label>
              <details open={latest}>
                <summary>预览并逐项采纳或拒绝</summary>
                <AssetBaseline
                  {...props}
                  key={`${item.snapshotId}:${revision}`}
                  assetId={assetId!}
                  snapshotId={item.snapshotId}
                  observationOnly
                  scope={
                    item.content === "docker"
                      ? "container-inventory"
                      : undefined
                  }
                />
              </details>
            </>
          )}
          {item.status === "awaiting_input" && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                awaiting.current = {
                  runId: run.id,
                  content: item.content,
                  previous: submittedObservation?.eventId,
                };
                onContent(item.content);
                onMethod(
                  run.configuration.items.find(
                    (i) => i.content === item.content,
                  )!.method,
                );
              }}
            >
              录入{collectionContents[item.content]}
            </button>
          )}
        </div>
      ))}
    </article>
  );
  return (
    <section className="asset-configuration" aria-label="操作系统与配置">
      <header>
        <div>
          <h3>{host ? "操作系统与配置" : "设备系统与配置"}</h3>
          <p>
            勾选采集内容，再分别配置方式。软件自动项取得系统包和可直接取得的版本，应用依赖另行生成或上传。
          </p>
        </div>
        <span>{platform === "linux" ? "Linux" : "Windows"}</span>
      </header>
      <div className="configuration-grid">
        {config.items.map((item) => {
          const available = item.content === "basic" || host;
          const automatic = host && platform === "linux";
          const methods =
            item.content === "docker"
              ? ["automatic", "script"]
              : ["automatic", "script", "manual"];
          return (
            <article
              key={item.content}
              className={active === item.content ? "active" : ""}
            >
              <label>
                <input
                  type="checkbox"
                  aria-label={`选择${collectionContents[item.content]}`}
                  disabled={busy || !loaded || !available}
                  checked={item.enabled && available}
                  onChange={(e) =>
                    update(item.content, { enabled: e.target.checked })
                  }
                />
                {collectionContents[item.content]}
              </label>
              {!available ? (
                <p>此设备类型不适用</p>
              ) : (
                <>
                  <label>
                    采集方式
                    <select
                      aria-label={`${collectionContents[item.content]}采集方式`}
                      disabled={busy || !loaded}
                      value={
                        item.method === "manual" && item.content === "docker"
                          ? "script"
                          : item.method
                      }
                      onChange={(e) => {
                        update(item.content, {
                          method: e.target.value as typeof item.method,
                        });
                        if (active === item.content) onMethod(e.target.value);
                      }}
                    >
                      {methods.map((m) => (
                        <option
                          key={m}
                          value={m}
                          disabled={m === "automatic" && !automatic}
                        >
                          {m === "automatic"
                            ? "自动采集"
                            : m === "script"
                              ? "脚本采集"
                              : "手动输入"}
                        </option>
                      ))}
                    </select>
                  </label>
                  {item.method === "automatic" && (
                    <label>
                      授权连接
                      <select
                        aria-label={`${collectionContents[item.content]}授权连接`}
                        value={item.profileId ?? ""}
                        disabled={busy || !loaded}
                        onChange={(e) =>
                          update(item.content, {
                            profileId: e.target.value || undefined,
                          })
                        }
                      >
                        <option value="">选择连接</option>
                        {profiles
                          .filter(
                            (p) =>
                              item.content !== "docker" ||
                              p.scopes.includes("container-inventory"),
                          )
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.label}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  {item.content === "software" && item.method === "script" && (
                    <>
                      <label>
                        应用组件目录
                        <input
                          aria-label="应用组件目录"
                          placeholder="例如 /opt/my-application"
                          value={item.softwarePath ?? ""}
                          onChange={(e) =>
                            update(item.content, {
                              softwarePath: e.target.value || undefined,
                            })
                          }
                        />
                      </label>
                      <button
                        type="button"
                        disabled={busy || !loaded || !item.softwarePath}
                        onClick={() => {
                          try {
                            downloadSoftwareComponentScript(
                              item.softwarePath!,
                              assetId!,
                            );
                            setNotice(
                              "在目标机运行 node ys-software-sbom.mjs，生成后上传组件资料并明确关联。需要目标机已安装Trivy。",
                            );
                          } catch (e) {
                            fail(e);
                          }
                        }}
                      >
                        下载软件组件脚本
                      </button>
                      <p>
                        只处理填写的应用目录。使用目标机原生路径；需要Node.js与Trivy。生成后在软件组件资料库上传，确认关联后才计入主机配置。
                      </p>
                    </>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || !loaded}
                    aria-pressed={active === item.content}
                    aria-label={`配置${collectionContents[item.content]}`}
                    onClick={() => {
                      onContent(item.content);
                      onMethod(
                        item.method === "manual" && item.content === "docker"
                          ? "script"
                          : item.method,
                      );
                    }}
                  >
                    配置{collectionContents[item.content]}
                  </button>
                </>
              )}
            </article>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <div className="configuration-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy || !loaded}
          onClick={() => void save()}
        >
          保存采集配置
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !loaded}
          onClick={() => void save(true)}
        >
          执行选中采集项
        </button>
      </div>
      {runs.length > 0 && (
        <>
          <section
            aria-label="最近一次采集结果"
            className="configuration-latest"
          >
            <h3>最近一次采集结果</h3>
            <p>
              采集完成后请核对以下资料，再确认采纳；采集本身不会自动扫描风险。
            </p>
            {renderRun(runs[0], true)}
          </section>
          <details className="configuration-history">
            <summary>
              历史配置采集批次（{Math.max(0, runs.length - 1)}）
            </summary>
            {runs.slice(1).map((run) => renderRun(run))}
          </details>
          <button
            type="button"
            className="primary"
            disabled={busy || !selected.length}
            onClick={() => void adopt()}
          >
            采纳选中结果
          </button>
        </>
      )}
    </section>
  );
}
