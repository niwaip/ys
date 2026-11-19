import { VersionLinks } from "./VersionLinks";
import { useEffect, useState, type FormEvent } from "react";
import type { AssetPage } from "../../../../../packages/contracts";
import type { CollectionSnapshot } from "../../../../../packages/contracts/collections";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import { requestId } from "../../request-id";
type Job = {
  id: string;
  status: string;
  scope: string;
  message: string;
  profileId: string;
  snapshotId: string | null;
  error: string | null;
  events: { type: string; message: string; at: string }[];
};
type Profile = { id: string; label: string; assetId: string; scopes: string[] };
type Section = {
  status: string;
  issues: string[];
  data?: unknown;
  items: unknown[];
  total: number | null;
  limit: number;
  offset: number;
};
const names: Record<string, string> = {
  os: "操作系统",
  packages: "系统包",
  hardware: "硬件",
  network: "网络",
  dockerClient: "Docker客户端",
  dockerDaemon: "运行Docker引擎",
  containers: "容器目录",
  images: "镜像目录",
};
const statuses: Record<string, string> = {
  acquired: "已取得",
  partial: "部分取得",
  not_collected: "未采集",
  unsupported: "不支持",
  permission_denied: "权限不足",
  failed: "失败",
  queued: "排队",
  running: "执行中",
  succeeded: "完成",
  unavailable: "不可用",
  interrupted: "已中断",
  timed_out: "超时",
};
export function CollectionsPage({
  customerId,
  token,
  onUnauthorized,
}: FeatureProps) {
  const [assets, setAssets] = useState<AssetPage>();
  const [target, setTarget] = useState("");
  const [tab, setTab] = useState("manual");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [snapshots, setSnapshots] = useState<{
    items: CollectionSnapshot[];
    total: number;
  }>();
  const [offset, setOffset] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<CollectionSnapshot>();
  const [section, setSection] = useState<Section>();
  const [sectionKey, setSectionKey] = useState("os");
  const [sectionOffset, setSectionOffset] = useState(0);
  const [raw, setRaw] = useState<string>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [jobKey, setJobKey] = useState(requestId);
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState("");
  const base = `/customers/${customerId}/collections`;
  function fail(e: unknown) {
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    Promise.all([
      api<AssetPage>(
        `/customers/${customerId}/assets?limit=100`,
        token,
        {},
        controller.signal,
      ),
      api<{ items: Profile[] }>(
        `${base}/profiles`,
        token,
        {},
        controller.signal,
      ),
      api<{ items: CollectionSnapshot[]; total: number }>(
        `${base}/snapshots?limit=20&offset=${offset}`,
        token,
        {},
        controller.signal,
      ),
    ])
      .then(([assets, profiles, snapshots]) => {
        if (controller.signal.aborted) return;
        setAssets(assets);
        setProfiles(profiles.items);
        setSnapshots(snapshots);
      })
      .catch((e) => {
        if (!controller.signal.aborted) fail(e);
      });
    return () => controller.abort();
  }, [base, token, revision, offset, onUnauthorized]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await api<{ items: Job[] }>(
          `${base}/jobs`,
          token,
          {},
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setJobs(result.items);
        if (
          result.items.some((job) => ["queued", "running"].includes(job.status))
        )
          timer = setTimeout(load, 1500);
      } catch (e) {
        if (!controller.signal.aborted) fail(e);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [base, token, revision, onUnauthorized]);
  useEffect(() => {
    setSection(undefined);
    setRaw(undefined);
    if (!selected) return;
    const controller = new AbortController();
    api<Section>(
      `${base}/snapshots/${selected.id}/sections/${sectionKey}?limit=50&offset=${sectionOffset}`,
      token,
      {},
      controller.signal,
    )
      .then(setSection)
      .catch((e) => {
        if (!controller.signal.aborted) fail(e);
      });
    return () => controller.abort();
  }, [base, token, selected, sectionKey, sectionOffset, onUnauthorized]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const values = new FormData(event.currentTarget);
    try {
      if (tab === "manual") {
        const os = Object.fromEntries(
          ["id", "version", "kernel", "architecture"].map((key) => [
            key,
            String(values.get(key) || "") || null,
          ]),
        );
        const hasOs = Object.values(os).some(Boolean);
        const saved = await api<CollectionSnapshot>(`${base}/manual`, token, {
          method: "POST",
          body: JSON.stringify({
            assetId: target,
            note: values.get("note"),
            data: {
              schemaVersion: "ys-host/1",
              identity: {
                hostname: values.get("hostname"),
                serial: String(values.get("serial") || "") || null,
                machineId: null,
              },
              collectedAt: values.get("collectedAt")
                ? new Date(String(values.get("collectedAt"))).toISOString()
                : null,
              sections: {
                os: {
                  status: hasOs ? "acquired" : "not_collected",
                  data: hasOs ? os : null,
                },
              },
              extensions: {},
            },
          }),
        });
        setSelected(saved);
        setNotice("人工来源快照已保存，尚未评估");
      } else if (tab === "upload") {
        const saved = await api<CollectionSnapshot>(`${base}/upload`, token, {
          method: "POST",
          body: JSON.stringify({ assetId: target, fileName, content }),
        });
        setSelected(saved);
        setNotice("原始资料与快照已保存，尚未评估");
      } else {
        const job = await api<Job>(`${base}/jobs`, token, {
          method: "POST",
          body: JSON.stringify({
            assetId: target,
            idempotencyKey: jobKey,
            profileId: values.get("profile"),
            scope: values.get("scope"),
            message: values.get("message"),
          }),
        });
        setNotice(
          `采集任务：${statuses[job.status] ?? job.status}${job.error ? `，${job.error}` : ""}`,
        );
        setJobKey(requestId());
      }
      setRevision((x) => x + 1);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function showSnapshot(id: string) {
    try {
      setSelected(
        await api<CollectionSnapshot>(`${base}/snapshots/${id}`, token),
      );
      setSectionOffset(0);
      setSectionKey("os");
    } catch (e) {
      fail(e);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ASSET COLLECTION</div>
          <h1>资产采集</h1>
          <p>
            先保存基础资料，再选择固定输入进行评估。基础采集不读取容器内部或应用目录。
          </p>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <section className="asset-panel">
        <h2>提交基础资料</h2>
        <label>
          目标资产编号
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            list="collection-assets"
            placeholder="选择或粘贴该客户资产UUID"
            required
          />
        </label>
        <datalist id="collection-assets">
          {assets?.items.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.name}
            </option>
          ))}
        </datalist>
        <p>候选显示前100项；更多资产可粘贴完整编号。</p>
        <div className="form-actions">
          {[
            ["manual", "手动输入"],
            ["upload", "上传脚本结果"],
            ["pi", "调用Pi Agent"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? "primary" : "secondary"}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <form onSubmit={submit} key={tab}>
          {tab === "manual" ? (
            <>
              <label>
                来源说明
                <input
                  name="note"
                  required
                  maxLength={1000}
                  placeholder="例如：客户现场提供"
                />
              </label>
              <label>
                主机名
                <input name="hostname" required maxLength={255} />
              </label>
              <label>
                序列号
                <input name="serial" maxLength={255} />
              </label>
              <label>
                已知采集时间
                <input type="datetime-local" name="collectedAt" />
              </label>
              <p>时间不清楚时留空。以下未知字段也可留空。</p>
              {[
                ["id", "OS发行版ID"],
                ["version", "OS版本"],
                ["kernel", "运行内核"],
                ["architecture", "架构"],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input name={key} maxLength={255} />
                </label>
              ))}
            </>
          ) : tab === "upload" ? (
            <>
              <p>
                支持ys-host/1
                JSON，最多5000000字节、50000条包记录；完整保留原始版本与扩展。软件/镜像SBOM请使用对应入口。
              </p>
              <label>
                采集JSON文件
                <input
                  type="file"
                  accept=".json,application/json"
                  required
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    setContent("");
                    setFileName("");
                    if (!file) return;
                    if (file.size > 5000000) {
                      setError("资料超过5000000字节，未截断上传");
                      return;
                    }
                    setContent(await file.text());
                    setFileName(file.name);
                  }}
                />
              </label>
              {content && (
                <details>
                  <summary>查看待上传原文</summary>
                  <pre>{content}</pre>
                </details>
              )}
            </>
          ) : (
            <>
              <label>
                受控连接
                <select name="profile" required>
                  <option value="">选择当前目标的预配置连接</option>
                  {profiles
                    .filter((p) => p.assetId === target)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                独立采集范围
                <select name="scope">
                  <option value="basic">
                    基础：OS、包、硬件、网络与可授权Docker版本
                  </option>
                  <option value="container-inventory">
                    独立容器/镜像目录（需要额外授权，不含内部组件）
                  </option>
                </select>
              </label>
              <label>
                采集需求
                <textarea
                  name="message"
                  required
                  maxLength={4000}
                  defaultValue="取得所选范围的基础资料，披露读取缺口。"
                />
              </label>
              <p>
                连接、主机身份及固定命令由服务端配置；目标无需安装Trivy。未配置Pi时会保存不可用任务。
              </p>
            </>
          )}
          <button
            className="primary"
            disabled={busy || !target || (tab === "upload" && !content)}
          >
            {busy ? "提交中…" : tab === "pi" ? "提交采集任务" : "保存基础快照"}
          </button>
        </form>
      </section>
      <section className="asset-panel">
        <div className="panel-heading">
          <h2>采集任务</h2>
          <button
            className="secondary"
            onClick={() => setRevision((x) => x + 1)}
          >
            刷新记录
          </button>
        </div>
        <p>运行任务自动刷新；终态重试使用新申请，重启中断不会自动重连。</p>
        {jobs.map((job) => (
          <details key={job.id}>
            <summary>
              {statuses[job.status] ?? job.status} · {job.scope} · {job.message}
            </summary>
            <code>{job.id}</code>
            {job.error && <p>{job.error}</p>}
            <ul>
              {job.events.map((event, index) => (
                <li key={index}>{event.message}</li>
              ))}
            </ul>
            {job.snapshotId && (
              <button
                className="secondary"
                onClick={() => void showSnapshot(job.snapshotId!)}
              >
                查看采集快照
              </button>
            )}
          </details>
        ))}
      </section>
      <section className="asset-panel">
        <h2>不可变采集快照</h2>
        <table>
          <thead>
            <tr>
              <th>对象 / 来源</th>
              <th>接入时间</th>
              <th>评估状态</th>
              <th>资料</th>
            </tr>
          </thead>
          <tbody>
            {snapshots?.items.map((snapshot) => (
              <tr key={snapshot.id}>
                <td>
                  {snapshot.identity.hostname} · {snapshot.entry}
                  <code>{snapshot.assetId}</code>
                </td>
                <td>{new Date(snapshot.importedAt).toLocaleString()}</td>
                <td>未评估</td>
                <td>
                  <button
                    className="text-button"
                    onClick={() => {
                      setSelected(snapshot);
                      setSectionOffset(0);
                    }}
                  >
                    查看分层资料
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="pagination">
          <span>共{snapshots?.total ?? 0}项</span>
          <button
            className="secondary"
            disabled={!offset}
            onClick={() => setOffset((x) => x - 20)}
          >
            上一页
          </button>
          <button
            className="secondary"
            disabled={offset + 20 >= (snapshots?.total ?? 0)}
            onClick={() => setOffset((x) => x + 20)}
          >
            下一页
          </button>
        </div>
      </section>
      {selected && (
        <section className="asset-panel">
          <h2>快照详情 · {selected.identity.hostname}</h2>
          <VersionLinks
            key={selected.id}
            customerId={customerId}
            token={token}
            onUnauthorized={onUnauthorized}
            snapshot={selected}
          />
          <code>{selected.id}</code>
          <p>
            采集时间：{selected.collectedAt ?? "未知"}；来源：{selected.entry}；
            {selected.note ?? ""}；尚未评估。
          </p>
          <p>SHA256：{selected.contentHash}</p>
          <label>
            资料分层
            <select
              value={sectionKey}
              onChange={(e) => {
                setSectionKey(e.target.value);
                setSectionOffset(0);
              }}
            >
              {Object.entries(names).map(([key, label]) => (
                <option key={key} value={key}>
                  {label} ·{" "}
                  {
                    statuses[
                      selected.sections[key as keyof typeof selected.sections]
                        .status
                    ]
                  }
                </option>
              ))}
            </select>
          </label>
          {section && (
            <>
              <p>
                {statuses[section.status]} · {section.issues.join("；")}
                {section.total !== null ? `，${section.total}项` : ""}
              </p>
              <pre>
                {JSON.stringify(section.data ?? section.items, null, 2)}
              </pre>
              {section.total !== null && (
                <div className="pagination">
                  <button
                    disabled={!sectionOffset}
                    onClick={() => setSectionOffset((x) => x - 50)}
                  >
                    上一批
                  </button>
                  <button
                    disabled={sectionOffset + 50 >= section.total}
                    onClick={() => setSectionOffset((x) => x + 50)}
                  >
                    下一批
                  </button>
                </div>
              )}
            </>
          )}
          <details>
            <summary>扩展与覆盖声明</summary>
            <pre>{JSON.stringify(selected.extensions, null, 2)}</pre>
          </details>
          <button
            className="secondary"
            onClick={async () => {
              try {
                setRaw(
                  (
                    await api<{ content: string }>(
                      `${base}/snapshots/${selected.id}/raw`,
                      token,
                    )
                  ).content,
                );
              } catch (e) {
                fail(e);
              }
            }}
          >
            读取原始资料
          </button>
          {raw && <pre>{raw}</pre>}
        </section>
      )}
    </>
  );
}
