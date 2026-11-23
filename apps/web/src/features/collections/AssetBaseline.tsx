import { deviceFieldLabels } from "../../../../../packages/contracts/device-collection";
import {
  hardwareSummary,
  networkSummary,
} from "../../../../../packages/contracts/collection-display";
import "./collections.css";
import { AssetSoftware } from "./AssetSoftware";
import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import { requestId } from "../../request-id";
import type { FeatureProps } from "../../features";
const labels: Record<string, string> = {
  identity: "主机身份",
  os: "操作系统",
  hardware: "硬件",
  device: "设备资料",
  network: "网络",
  dockerClient: "Docker客户端",
  dockerDaemon: "Docker引擎",
  packages: "系统包",
  containers: "容器目录",
  images: "镜像目录",
};
const fields: Record<string, string> = {
  ...deviceFieldLabels,
  category: "设备类型",
  hostname: "主机名",
  serial: "序列号",
  machineId: "机器标识",
  id: "发行版",
  version: "版本",
  kernel: "运行内核",
  architecture: "架构",
  cpu: "CPU",
  memory: "内存",
  disks: "磁盘",
  name: "名称",
  manager: "包管理器",
  state: "安装状态",
  raw: "原始版本信息",
};
const states: Record<string, string> = {
  acquired: "已取得",
  partial: "部分取得",
  not_collected: "未采集",
  unsupported: "不支持",
  permission_denied: "权限不足",
  failed: "失败",
};
type Changes = { key: string; kind: string; before?: unknown; after?: unknown };
type Preview = {
  asset: { name: string; attributes: Record<string, unknown> };
  netboxConfigured: boolean;
  current: { id: string; actor: string; createdAt: string } | null;
  snapshot: {
    id: string;
    identity: { hostname: string };
    importedAt: string;
  } | null;
  sections: Record<
    string,
    {
      status: string;
      comparable: boolean;
      counts: { added: number; removed: number; changed: number };
      totalChanges: number;
      changes: Changes[];
      issues: string[];
    }
  >;
  review?: { status: string; reason?: string; actor?: string };
  history: {
    id: string;
    status: string;
    actor: string;
    createdAt: string;
    snapshotId: string;
  }[];
};
type Page = {
  data: unknown;
  items: unknown[];
  total: number;
  offset: number;
  changes: Changes[];
};
function valueText(v: unknown): string {
  if (v == null) return "未知";
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}
function capacity(value: number | null | undefined) {
  return value == null ? "未知" : `${(value / 1024 ** 3).toFixed(1)} GiB`;
}
function HardwareView({
  value,
  changes,
  excluded,
  onExclude,
  canSelect,
}: {
  value: unknown;
  changes: Changes[];
  excluded: string[];
  onExclude: (key: string, value: boolean) => void;
  canSelect: boolean;
}) {
  const h = hardwareSummary(value);
  return (
    <div className="baseline-capacity">
      <div
        className={
          changes.some((c) => c.key === "cpu") ? "baseline-field-changed" : ""
        }
      >
        <span>CPU核数</span>
        <strong>
          {h.cpu.cores ?? "未知"}
          {h.cpu.cores ? " 核" : ""}
        </strong>
        {canSelect && (
          <label className="collect-check">
            <input
              type="checkbox"
              checked={!excluded.includes("hardware.cpu")}
              onChange={(e) => onExclude("hardware.cpu", !e.target.checked)}
            />
            采纳
          </label>
        )}
      </div>
      <div
        className={
          changes.some((c) => c.key === "memory")
            ? "baseline-field-changed"
            : ""
        }
      >
        <span>内存容量</span>
        <strong>{capacity(h.memory.bytes)}</strong>
        {canSelect && (
          <label className="collect-check">
            <input
              type="checkbox"
              checked={!excluded.includes("hardware.memory")}
              onChange={(e) => onExclude("hardware.memory", !e.target.checked)}
            />
            采纳
          </label>
        )}
      </div>
      <div
        className={
          changes.some((c) => c.key === "disks") ? "baseline-field-changed" : ""
        }
      >
        <span title="已挂载本地文件系统容量之和，不代表未挂载物理磁盘容量">
          磁盘容量
        </span>
        <strong>{capacity(h.disks.bytes)}</strong>
        {canSelect && (
          <label className="collect-check">
            <input
              type="checkbox"
              checked={!excluded.includes("hardware.disks")}
              onChange={(e) => onExclude("hardware.disks", !e.target.checked)}
            />
            采纳
          </label>
        )}
      </div>
    </div>
  );
}
function DiffValue({ value }: { value: unknown }) {
  if (value == null) return <span>无</span>;
  if (typeof value !== "object" || Array.isArray(value))
    return <span>{valueText(value)}</span>;
  return (
    <dl className="baseline-diff-value">
      {Object.entries(value).map(([key, v]) => (
        <div key={key}>
          <dt>{fields[key] ?? key}</dt>
          <dd>
            {v && typeof v === "object" ? (
              <details>
                <summary>详细资料</summary>
                <pre>{valueText(v)}</pre>
              </details>
            ) : (
              valueText(v)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
function Layer({
  name,
  base,
  snapshotId,
  token,
  info,
  view,
  onExclude,
  excluded,
  onError,
  readOnly = false,
}: {
  readOnly?: boolean;
  name: string;
  base: string;
  snapshotId: string;
  token: string;
  info: Preview["sections"][string];
  view: string;
  onExclude: (field: string, excluded: boolean) => void;
  excluded: string[];
  onError: (e: unknown) => void;
}) {
  const [page, setPage] = useState<Page>(),
    [offset, setOffset] = useState(0),
    [q, setQ] = useState(""),
    [changesOnly, setChangesOnly] = useState(false);
  useEffect(() => {
    setOffset(0);
  }, [q, changesOnly, view, snapshotId]);
  useEffect(() => {
    setChangesOnly(false);
  }, [view, snapshotId]);
  useEffect(() => {
    const c = new AbortController();
    const params = new URLSearchParams({
      snapshotId,
      view,
      offset: String(offset),
      q,
      changesOnly: String(changesOnly),
    });
    api<Page>(`${base}/sections/${name}?${params}`, token, {}, c.signal)
      .then((v) => {
        if (!c.signal.aborted) setPage(v);
      })
      .catch((e) => {
        if (!c.signal.aborted) onError(e);
      });
    return () => c.abort();
  }, [base, snapshotId, view, offset, q, changesOnly, token, name]);
  type NetworkRow = {
    ifname: string;
    addresses: string[] | null;
    status: string | null;
    change?: Changes;
  };
  const networkRows: NetworkRow[] =
    name === "network"
      ? changesOnly
        ? (page?.items ?? [])
            .filter(
              (item) =>
                item !== null && typeof item === "object" && "kind" in item,
            )
            .map((item) => {
              const change = item as Changes;
              return {
                ...((change.after ?? change.before) as NetworkRow),
                change,
              };
            })
        : networkSummary(page?.items).map((v) => ({
            ...v,
            change:
              view === "observed"
                ? info.changes.find((c) => c.key === v.ifname)
                : undefined,
          }))
      : [];
  const list = ["packages", "network", "containers", "images"].includes(name);
  return (
    <div className="baseline-layer-content">
      {info.issues.map((issue, i) => (
        <p className="collect-muted" key={i}>
          {issue}
        </p>
      ))}
      {name === "hardware" ? (
        <HardwareView
          value={page?.data}
          excluded={excluded}
          onExclude={onExclude}
          canSelect={!readOnly && view === "observed"}
          changes={view === "observed" ? info.changes : []}
        />
      ) : name === "network" ? (
        <>
          {view === "observed" && info.comparable && (
            <label className="collect-check">
              <input
                type="checkbox"
                checked={changesOnly}
                onChange={(e) => {
                  setPage(undefined);
                  setChangesOnly(e.target.checked);
                }}
              />
              仅显示变化
            </label>
          )}

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>接口</th>
                  <th>IP地址</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {networkRows.map((v, i) => {
                  const change = v.change;
                  const old = change?.before as
                    { addresses?: string[]; status?: string } | undefined;
                  return (
                    <tr
                      key={i}
                      className={change ? "baseline-field-changed" : ""}
                    >
                      <td>
                        {v.ifname}
                        {change && (
                          <span className="baseline-change changed">
                            {change.kind === "added"
                              ? "新增"
                              : change.kind === "removed"
                                ? "删除"
                                : "变更"}
                          </span>
                        )}
                      </td>
                      <td>
                        {v.addresses == null
                          ? "未知"
                          : v.addresses.length
                            ? v.addresses.join(" · ")
                            : "无地址"}
                        {old && (
                          <small className="block subtle">
                            基线：{old.addresses?.join(" · ") ?? "未知"}
                          </small>
                        )}
                      </td>
                      <td>{v.status ?? "未知"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <span>共 {page?.total ?? 0} 项</span>
            <button
              className="secondary"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              上一批
            </button>
            <button
              className="secondary"
              disabled={!page || offset + 50 >= page.total}
              onClick={() => setOffset(offset + 50)}
            >
              下一批
            </button>
          </div>
        </>
      ) : list ? (
        <>
          <div className="baseline-list-controls">
            <input
              aria-label={`搜索${labels[name]}`}
              placeholder={`搜索${labels[name]}`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {info.comparable && (
              <label className="collect-check">
                <input
                  type="checkbox"
                  checked={changesOnly}
                  onChange={(e) => {
                    setPage(undefined);
                    setChangesOnly(e.target.checked);
                  }}
                />
                仅显示变化
              </label>
            )}
          </div>
          <div className="table-scroll">
            <table
              className={
                name === "containers" ? "baseline-containers-table" : undefined
              }
            >
              <thead>
                <tr>
                  {changesOnly ? (
                    <>
                      <th>变化</th>
                      <th>原值</th>
                      <th>本次值</th>
                    </>
                  ) : name === "packages" ? (
                    <>
                      <th>包名称</th>
                      <th>版本</th>
                      <th>架构</th>
                      <th>状态</th>
                    </>
                  ) : name === "containers" ? (
                    <>
                      <th>容器</th>
                      <th>镜像</th>
                      <th>状态</th>
                    </>
                  ) : name === "images" ? (
                    <>
                      <th>镜像仓库</th>
                      <th>标签</th>
                      <th>镜像标识</th>
                    </>
                  ) : (
                    <>
                      <th>条目</th>
                      <th>资料</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {page?.items.map((item, i) => {
                  const v = item as Record<string, unknown>;
                  return (
                    <tr key={i}>
                      {changesOnly ? (
                        <>
                          <td>
                            <span className={`baseline-change ${v.kind}`}>
                              {
                                {
                                  added: "新增",
                                  removed: "删除",
                                  changed: "变更",
                                }[String(v.kind)]
                              }
                            </span>
                          </td>
                          <td>
                            <DiffValue value={v.before} />
                          </td>
                          <td>
                            <DiffValue value={v.after} />
                          </td>
                        </>
                      ) : name === "packages" ? (
                        <>
                          <td>{String(v.name)}</td>
                          <td>{String(v.version ?? "未知")}</td>
                          <td>{String(v.architecture ?? "未知")}</td>
                          <td>{String(v.state)}</td>
                        </>
                      ) : name === "containers" ? (
                        <>
                          <td>
                            <strong>
                              {String(
                                v.name ?? v.Names ?? v.containerId ?? "未知",
                              )}
                            </strong>
                            <small className="block subtle">
                              {String(v.containerId ?? v.ID ?? "")}
                            </small>
                          </td>
                          <td>
                            {String(v.image ?? v.imageId ?? v.Image ?? "未知")}
                          </td>
                          <td>{String(v.state ?? v.State ?? "未知")}</td>
                        </>
                      ) : name === "images" ? (
                        <>
                          <td>
                            {String(v.repository ?? v.Repository ?? "未知")}
                          </td>
                          <td>{String(v.tag ?? v.Tag ?? "未知")}</td>
                          <td>{String(v.imageId ?? v.id ?? v.ID ?? "未知")}</td>
                        </>
                      ) : (
                        <>
                          <td>
                            {String(
                              v.ifname ??
                                v.name ??
                                v.repository ??
                                v.containerId ??
                                i + 1,
                            )}
                          </td>
                          <td>
                            <details>
                              <summary>展开资料</summary>
                              <pre>{valueText(item)}</pre>
                            </details>
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <span>共 {page?.total ?? 0} 项</span>
            <button
              className="secondary"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              上一批
            </button>
            <button
              className="secondary"
              disabled={!page || offset + 50 >= page.total}
              onClick={() => setOffset(offset + 50)}
            >
              下一批
            </button>
          </div>
        </>
      ) : (
        <dl className="baseline-properties">
          {page?.data && typeof page.data === "object" ? (
            Object.entries(page.data).map(([key, value]) => {
              const changed = info.changes.find((c) => c.key === key);
              const path = `${name}.${key}`;
              return (
                <div
                  key={key}
                  className={
                    changed && view === "observed"
                      ? "baseline-field-changed"
                      : ""
                  }
                >
                  <dt>
                    {fields[key] ?? key}
                    {changed && view === "observed" && (
                      <span className="baseline-change changed">
                        {changed.kind === "added" ? "新增" : "变更"}
                      </span>
                    )}
                  </dt>
                  <dd>
                    {(value !== null && typeof value === "object") ||
                    valueText(value).length > 160 ? (
                      <details>
                        <summary>展开资料</summary>
                        <pre>{valueText(value)}</pre>
                      </details>
                    ) : (
                      valueText(value)
                    )}
                    {changed?.before !== undefined && view === "observed" && (
                      <small>
                        基线：{valueText(changed.before).slice(0, 200)}
                      </small>
                    )}
                  </dd>
                  {!readOnly &&
                    view === "observed" &&
                    [
                      "identity",
                      "os",
                      "hardware",
                      "dockerClient",
                      "dockerDaemon",
                    ].includes(name) && (
                      <label className="collect-check">
                        <input
                          type="checkbox"
                          checked={!excluded.includes(path)}
                          onChange={(e) => onExclude(path, !e.target.checked)}
                        />
                        采纳此字段
                      </label>
                    )}
                </div>
              );
            })
          ) : (
            <p className="collect-muted">暂无资料</p>
          )}
        </dl>
      )}
    </div>
  );
}
export function AssetBaseline({
  customerId,
  token,
  onUnauthorized,
  assetId,
  snapshotId,
  onConfirmed,
  readOnly = false,
  scope,
  observationOnly = false,
}: {
  observationOnly?: boolean;
  scope?: "container-inventory";
  readOnly?: boolean;
  assetId: string;
  snapshotId?: string;
  onConfirmed?: () => void;
} & FeatureProps) {
  const containerScope = scope === "container-inventory";
  const containerSections = [
    "dockerClient",
    "dockerDaemon",
    "containers",
    "images",
  ];
  const [activeTab, setActiveTab] = useState(
    containerScope ? "containers" : "identity",
  );
  const [data, setData] = useState<Preview>(),
    [selected, setSelected] = useState<string[]>([]),
    [excluded, setExcluded] = useState<string[]>([]),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [view, setView] = useState("observed"),
    [rejectReason, setRejectReason] = useState("");
  const base = `/customers/${customerId}/assets/${assetId}/baseline`;
  function fail(e: unknown) {
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  useEffect(() => {
    const c = new AbortController();
    api<Preview>(
      `${base}${snapshotId ? "?snapshotId=" + snapshotId : ""}`,
      token,
      {},
      c.signal,
    )
      .then((v) => {
        if (c.signal.aborted) return;
        setData(v);
        if (readOnly) setView(v.current ? "baseline" : "observed");
        setSelected(
          Object.entries(v.sections)
            .filter(
              ([name, s]) =>
                s.comparable &&
                (!containerScope || containerSections.includes(name)),
            )
            .map(([key]) => key),
        );
        setExcluded([]);
      })
      .catch((e) => {
        if (!c.signal.aborted) fail(e);
      });
    return () => c.abort();
  }, [base, snapshotId, token, revision]);
  async function confirm() {
    if (!data?.snapshot) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ status: string; message?: string }>(
        base + "/confirm",
        token,
        {
          method: "POST",
          body: JSON.stringify({
            writeMasterData: !observationOnly,
            snapshotId: data.snapshot.id,
            expectedBaselineId: data.current?.id ?? null,
            idempotencyKey: requestId(),
            sections: selected,
            excludeFields: excluded,
          }),
        },
      );
      if (r.status === "confirmed") setNotice("已确认并更新资产基线");
      else {
        setNotice("");
        setError(r.message ?? "写回待核对");
      }
      setRevision((v) => v + 1);
      onConfirmed?.();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function reject() {
    if (!data?.snapshot) return;
    setBusy(true);
    setError("");
    try {
      await api(base + "/reject", token, {
        method: "POST",
        body: JSON.stringify({
          snapshotId: data.snapshot.id,
          reason: rejectReason,
        }),
      });
      setRevision((v) => v + 1);
      onConfirmed?.();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: string) {
    setBusy(true);
    setError("");
    try {
      await api(base + `/${id}/cancel`, token, { method: "POST", body: "{}" });
      setRevision((v) => v + 1);
      setNotice("已放弃本次采纳，保留原基线；NetBox实际值请按需同步核对");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function reconcile(id: string) {
    setBusy(true);
    try {
      await api(base + `/${id}/reconcile`, token, {
        method: "POST",
        body: "{}",
      });
      setRevision((v) => v + 1);
      setNotice("已核对远端，基线更新完成");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <p role={error ? "alert" : "status"}>{error || "正在读取资产资料…"}</p>
    );
  const tabs: Record<string, string[]> = {
    identity: ["identity"],
    os: ["os"],
    hardware: ["hardware"],
    device: ["device"],
    network: ["network"],
    packages: ["packages"],
    docker: ["dockerClient", "dockerDaemon"],
    containers: ["containers", "images"],
    software: [],
  };
  const tabLabels = {
    ...labels,
    docker: "Docker 环境",
    containers: "容器",
    software: "软件 / 项目",
  };
  return (
    <div className="asset-baseline">
      <div className="baseline-overview">
        <div>
          <span className="collect-kicker">
            {containerScope ? "容器采集资料" : "资产基础资料"}
          </span>
          <h2>{data.asset.name}</h2>
          <p>
            {data.current
              ? `已确认基线 · ${new Date(data.current.createdAt).toLocaleString("zh-CN")} · ${data.current.actor}`
              : "尚无已确认基线"}
          </p>
        </div>
        <div>
          <span className="collect-pill">
            {data.netboxConfigured ? "NetBox 主数据" : "本地资产模式"}
          </span>
          <p>
            {data.snapshot
              ? "最近资料：" +
                new Date(data.snapshot.importedAt).toLocaleString("zh-CN")
              : "尚未采集资料"}
          </p>
        </div>
      </div>
      {observationOnly && (
        <p className="notice" role="status">
          <span>
            {data.review?.status === "confirmed"
              ? "已采纳"
              : data.review?.status === "rejected"
                ? "已拒绝采纳"
                : "待确认采纳"}
          </span>
          {data.review?.reason ? ` · ${data.review.reason}` : ""}
        </p>
      )}
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
      {!data.snapshot ? (
        <div className="collect-empty">
          <h3>这台资产还没有采集资料</h3>
          <p>在“资产采集”中选择该主机，配置访问后开始基础采集。</p>
          <details>
            <summary>查看登记属性</summary>
            <pre>{valueText(data.asset.attributes)}</pre>
          </details>
        </div>
      ) : (
        <>
          <div className="baseline-toolbar">
            <div>
              <button
                type="button"
                className={view === "observed" ? "primary" : "secondary"}
                onClick={() => setView("observed")}
              >
                本次采集与变更
              </button>
              <button
                type="button"
                className={view === "baseline" ? "primary" : "secondary"}
                disabled={!data.current}
                onClick={() => setView("baseline")}
              >
                已确认基础数据
              </button>
            </div>
            <strong>
              {Object.entries(data.sections)
                .filter(
                  ([name]) =>
                    !containerScope || containerSections.includes(name),
                )
                .reduce((n, [, section]) => n + section.totalChanges, 0)}{" "}
              项待比较变化
            </strong>
          </div>
          <div
            className="baseline-tabs"
            role="tablist"
            aria-label="资产资料分区"
          >
            {Object.keys(tabs)
              .filter(
                (key) =>
                  !containerScope || ["docker", "containers"].includes(key),
              )
              .map((key) => (
                <button
                  type="button"
                  key={key}
                  role="tab"
                  aria-selected={activeTab === key}
                  aria-label={tabLabels[key as keyof typeof tabLabels]}
                  aria-controls={`baseline-${key}`}
                  onClick={() => setActiveTab(key)}
                >
                  {tabLabels[key as keyof typeof tabLabels]}
                  {tabs[key].some(
                    (name) => data.sections[name]?.totalChanges,
                  ) ? (
                    <b>
                      {tabs[key].reduce(
                        (sum, name) =>
                          sum + (data.sections[name]?.totalChanges ?? 0),
                        0,
                      )}
                    </b>
                  ) : null}
                </button>
              ))}
          </div>
          {!readOnly && view === "observed" && (
            <p className="collect-muted">
              勾选完整取得的区块，展开可排除字段。未取得或部分取得的区块保留原基线；清单仅在完整取得时比较删除。
            </p>
          )}
          {activeTab === "software" && (
            <AssetSoftware
              customerId={customerId}
              token={token}
              assetId={assetId}
              kind="software"
              onError={fail}
            />
          )}
          {activeTab === "containers" && !containerScope && (
            <AssetSoftware
              customerId={customerId}
              token={token}
              assetId={assetId}
              kind="container"
              onError={fail}
            />
          )}
          {Object.entries(labels)
            .filter(([name]) => tabs[activeTab]?.includes(name))
            .map(([name, label]) => {
              const info = data.sections[name];
              return (
                <section
                  className={
                    "baseline-layer " + (info.totalChanges ? "has-changes" : "")
                  }
                  role="tabpanel"
                  id={`baseline-${name}`}
                  key={name}
                >
                  <header>
                    <div>
                      <h3>{label}</h3>
                      <span className="collect-pill">
                        {view === "baseline"
                          ? "已确认资料"
                          : states[info.status]}
                      </span>
                    </div>
                    <div>
                      {info.totalChanges > 0 && view === "observed" && (
                        <span className="baseline-change changed">
                          新增 {info.counts.added} · 变更 {info.counts.changed}{" "}
                          · 删除 {info.counts.removed}
                        </span>
                      )}
                      {!readOnly && view === "observed" && (
                        <label className="collect-check">
                          <input
                            aria-label={`采纳${label}`}
                            type="checkbox"
                            disabled={!info.comparable || busy}
                            checked={selected.includes(name)}
                            onChange={(e) =>
                              setSelected((v) =>
                                e.target.checked
                                  ? [...v, name]
                                  : v.filter((n) => n !== name),
                              )
                            }
                          />
                          采纳
                        </label>
                      )}
                    </div>
                  </header>
                  <Layer
                    key={`${name}:${revision}`}
                    name={name}
                    base={base}
                    snapshotId={data.snapshot!.id}
                    token={token}
                    info={info}
                    view={view}
                    excluded={excluded}
                    onExclude={(path, value) =>
                      setExcluded((v) =>
                        value ? [...v, path] : v.filter((p) => p !== path),
                      )
                    }
                    onError={fail}
                    readOnly={readOnly}
                  />
                </section>
              );
            })}
          {!readOnly &&
            view === "observed" &&
            (!observationOnly || data.review?.status !== "rejected") && (
              <div className="baseline-confirm">
                <div>
                  <strong>
                    {containerScope
                      ? "是否采纳本次容器资料？"
                      : "确认本次基础资料"}
                  </strong>
                  <p>
                    {containerScope
                      ? "仅将勾选的 Docker、容器与镜像目录保存为YS资产基线，不修改主机身份。"
                      : observationOnly
                        ? "选中资料仅保存为YS资产基线，NetBox主数据保持独立维护。"
                        : data.netboxConfigured
                          ? "主机身份区块的主机名、序列号将写回NetBox；其他区块保存在YS资产基线。"
                          : "当前未配置NetBox，将更新YS资产基线。"}{" "}
                    原始采集记录保留。
                  </p>
                </div>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !selected.length ||
                    data.history.some((h) =>
                      ["pending", "unknown"].includes(h.status),
                    )
                  }
                  onClick={() => void confirm()}
                >
                  {busy
                    ? "处理中…"
                    : observationOnly && data.review?.status === "confirmed"
                      ? "补充采纳选中资料"
                      : containerScope
                        ? "确认采纳容器资料"
                        : "确认选中资料并更新基线"}
                </button>
              </div>
            )}
        </>
      )}
      {observationOnly &&
        data.snapshot &&
        data.review?.status === "pending" && (
          <div className="collect-reject">
            <label>
              拒绝原因
              <input
                value={rejectReason}
                maxLength={1000}
                onChange={(e) => setRejectReason(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !rejectReason.trim()}
              onClick={() => void reject()}
            >
              拒绝采纳
            </button>
          </div>
        )}
      <details className="collect-options">
        <summary>基线确认记录</summary>
        {data.history.length ? (
          data.history.map((h) => (
            <div className="baseline-history" key={h.id}>
              <span>
                {new Date(h.createdAt).toLocaleString("zh-CN")} · {h.actor} ·{" "}
                {{
                  confirmed: "已确认",
                  pending: "写回处理中",
                  cancelled: "已放弃采纳",
                  rejected: "未执行写回",
                  unknown: "写回未获确认",
                }[h.status] ?? h.status}
              </span>
              {!readOnly && h.status === "unknown" && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void reconcile(h.id)}
                >
                  核对NetBox当前值
                </button>
              )}
              {!readOnly && h.status === "unknown" && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void cancel(h.id)}
                >
                  放弃本次采纳
                </button>
              )}
            </div>
          ))
        ) : (
          <p>尚无确认记录</p>
        )}
      </details>
    </div>
  );
}
