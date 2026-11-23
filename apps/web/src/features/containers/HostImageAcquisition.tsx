import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import { requestId } from "../../request-id";
import type { FeatureProps } from "../../features";
import type { AssetPage } from "../../../../../packages/contracts";
import {
  runtimeTerminal,
  type ContainerJob,
  type ContainerSource,
  type RuntimeImage,
} from "../../../../../packages/contracts/container-runtime";
export type ImageSelection = {
  containerId: string;
  versionId: string;
  assessmentId?: string;
  sourceId?: string;
};
type Inventory = {
  snapshotId: string;
  assetId: string;
  items: RuntimeImage[];
  imagesStatus: string;
  containersStatus: string;
  issues: string[];
};
const statuses: Record<string, string> = {
  queued: "等待生成",
  generating: "正在生成SBOM",
  assessing: "正在漏洞评估",
  succeeded: "扫描完成",
  failed: "失败",
  unavailable: "工具或连接不可用",
  timed_out: "超时",
  interrupted: "已中断",
};
export function HostImageAcquisition(
  props: FeatureProps & {
    mode: string;
    setMode: (mode: string) => void;
    onSelect: (selection: ImageSelection) => Promise<void>;
  },
) {
  const [assets, setAssets] = useState<AssetPage>(),
    [offset, setOffset] = useState(0),
    [assetId, setAssetId] = useState(props.assetId ?? ""),
    [profiles, setProfiles] = useState<
      { id: string; label: string; assetId: string; scopes: string[] }[]
    >([]),
    [profileId, setProfileId] = useState(""),
    [inventory, setInventory] = useState<Inventory>(),
    [discovery, setDiscovery] = useState<{
      id: string;
      status: string;
      error?: string;
      snapshotId?: string;
    }>(),
    [selected, setSelected] = useState<string[]>([]),
    [runningOnly, setRunningOnly] = useState(true),
    [jobs, setJobs] = useState<ContainerJob[]>([]),
    [sources, setSources] = useState<ContainerSource[]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [file, setFile] = useState<File>(),
    [name, setName] = useState("");
  const c = useRef(new AbortController()),
    base = `/customers/${props.customerId}`,
    key = useRef(requestId());
  const call = <T,>(path: string, method = "GET", body?: unknown) =>
    api<T>(
      `${base}${path}`,
      props.token,
      { method, ...(body ? { body: JSON.stringify(body) } : {}) },
      c.current.signal,
    );
  const fail = (e: unknown) => {
    if (c.current.signal.aborted) return;
    if (e instanceof ApiError && e.status === 401) props.onUnauthorized();
    else setError((e as Error).message);
  };
  const refresh = async () => {
    const suffix = assetId ? `?assetId=${assetId}` : "";
    const [tasks, observations] = await Promise.all([
      call<{ items: ContainerJob[] }>(`/container-runtime/jobs${suffix}`),
      call<{ items: ContainerSource[] }>(`/container-runtime/sources${suffix}`),
    ]);
    setJobs(tasks.items);
    setSources(observations.items);
  };
  useEffect(() => {
    c.current = new AbortController();
    Promise.all([
      call<AssetPage>(`/assets?limit=100&offset=${offset}`).then(setAssets),
      call<{ items: typeof profiles }>("/collections/profiles").then((r) =>
        setProfiles(r.items),
      ),
      refresh(),
    ]).catch(fail);
    return () => c.current.abort();
  }, [props.customerId, props.token, assetId, offset]);
  useEffect(() => {
    setProfileId("");
    setInventory(undefined);
    setSelected([]);
    setDiscovery(undefined);
    key.current = requestId();
  }, [assetId]);
  useEffect(() => {
    const snapshotId = props.collectionContext?.snapshotId;
    if (!snapshotId || assetId !== props.assetId) return;
    let cancelled = false;
    call<Inventory>(`/container-runtime/inventory/${snapshotId}`)
      .then((data) => {
        if (cancelled) return;
        if (data.assetId !== assetId)
          throw new Error("固定目录不属于当前目标主机");
        setInventory(data);
        setNotice("已载入所选固定目录；未重新发现或自动扫描镜像");
      })
      .catch((e) => {
        if (!cancelled) fail(e);
      });
    return () => {
      cancelled = true;
    };
  }, [assetId, props.collectionContext?.snapshotId]);
  useEffect(() => {
    const id = props.collectionContext?.profileId;
    if (
      id &&
      profiles.some(
        (p) =>
          p.id === id &&
          p.assetId === assetId &&
          p.scopes.includes("container-inventory"),
      )
    )
      setProfileId(id);
  }, [assetId, profiles, props.collectionContext?.profileId]);
  useEffect(() => {
    if (!discovery || !["queued", "running"].includes(discovery.status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const job = await call<NonNullable<typeof discovery>>(
          `/collections/jobs/${discovery.id}`,
        );
        if (cancelled) return;
        if (job.snapshotId) {
          const data = await call<Inventory>(
            `/container-runtime/inventory/${job.snapshotId}`,
          );
          if (cancelled) return;
          setInventory(data);
          setSelected([]);
          setNotice("镜像目录已取得，请选择要生成并扫描的镜像");
        } else if (!["queued", "running"].includes(job.status))
          setError(job.error ?? "目录未取得");
        setDiscovery(job);
      } catch (e) {
        if (!cancelled) fail(e);
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [discovery?.id, discovery?.status]);
  useEffect(() => {
    if (!jobs.some((j) => !runtimeTerminal(j.status))) return;
    const t = setInterval(() => void refresh().catch(fail), 1800);
    return () => clearInterval(t);
  }, [jobs, assetId]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      fail(e);
    } finally {
      if (!c.current.signal.aborted) setBusy(false);
    }
  }
  const available = profiles.filter(
    (p) => p.assetId === assetId && p.scopes.includes("container-inventory"),
  );
  const rows =
    inventory?.items.filter(
      (i) => !runningOnly || i.containers.some((c) => c.state === "running"),
    ) ?? [];
  return (
    <section className="container-acquisition">
      <div className="workspace-tabs" role="tablist">
        {[
          ["host", "选择主机生成"],
          ["manual", "手动镜像资料"],
          ["offline", "离线脚本"],
        ].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={props.mode === id}
            className={props.mode === id ? "primary" : "secondary"}
            onClick={() => props.setMode(id)}
          >
            {label}
          </button>
        ))}
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
      <section className="panel">
        <h2>{props.mode === "host" ? "选择主机与连接" : "资料归属"}</h2>
        <label>
          容器所属主机
          <select
            aria-label="容器所属主机"
            value={assetId}
            onChange={(e) => setAssetId(e.target.value)}
          >
            <option value="">
              {props.mode === "host"
                ? "请选择主机"
                : "独立镜像资料（不关联主机）"}
            </option>
            {assets?.items.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {assets && assets.total > 100 && (
          <div>
            <button
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 100))}
            >
              上一批主机
            </button>
            <button
              disabled={offset + 100 >= assets.total}
              onClick={() => setOffset(offset + 100)}
            >
              下一批主机
            </button>
          </div>
        )}
        {props.mode === "host" ? (
          <>
            <label>
              Docker 已授权连接
              <select
                aria-label="Docker 已授权连接"
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
              >
                <option value="">选择连接</option>
                {available.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {assetId && !available.length && (
              <p>
                该主机没有已授权 Docker
                连接。请到资产采集配置连接，或使用离线脚本上传。
              </p>
            )}
            <button
              disabled={
                busy ||
                !assetId ||
                !profileId ||
                (!!discovery &&
                  ["queued", "running"].includes(discovery.status))
              }
              onClick={() =>
                void run(async () => {
                  setInventory(undefined);
                  setSelected([]);
                  setDiscovery(
                    await call("/container-runtime/discover", "POST", {
                      assetId,
                      profileId,
                      idempotencyKey: requestId(),
                    }),
                  );
                })
              }
            >
              发现主机镜像
            </button>
            {discovery && (
              <p>
                目录采集：
                {discovery.status === "queued"
                  ? "等待采集"
                  : discovery.status === "running"
                    ? "正在采集"
                    : discovery.snapshotId
                      ? "目录已保存"
                      : "未取得目录"}
              </p>
            )}
          </>
        ) : (
          <>
            <p>
              上传 CycloneDX 镜像 SBOM 或脚本生成的 ys-image/1
              JSON；主机关联由操作员明确声明。
            </p>
            {props.mode === "offline" && (
              <>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const script = await call<{
                        fileName: string;
                        content: string;
                      }>("/container-runtime/script");
                      const url = URL.createObjectURL(
                        new Blob([script.content], { type: "text/javascript" }),
                      );
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = script.fileName;
                      a.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    })
                  }
                >
                  下载镜像生成脚本
                </button>
                <p>在目标主机准备 Node.js、Docker 和 Trivy，再运行：</p>
                <code>
                  node ys-image-sbom.mjs sha256:完整ImageID &gt; image.json
                </code>
                <p>脚本只读取本地 Docker 镜像，不拉取仓库镜像，不安装软件。</p>
              </>
            )}
            <label>
              上传镜像名称
              <input
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              镜像资料文件
              <input
                aria-label="镜像资料文件"
                type="file"
                accept=".json"
                onChange={(e) => setFile(e.target.files?.[0])}
              />
            </label>
            <button
              disabled={busy || !file || !name.trim()}
              onClick={() =>
                void run(async () => {
                  if (!file) return;
                  if (file.size > 20000000)
                    throw new Error("资料最多20000000字节，不会截断");
                  const content = new TextDecoder("utf-8", {
                    fatal: true,
                  }).decode(await file.arrayBuffer());
                  const result = await call<{
                    version: { containerId: string; id: string };
                    source: ContainerSource;
                  }>("/container-runtime/imports", "POST", {
                    name,
                    fileName: file.name,
                    content,
                    ...(assetId ? { assetId } : {}),
                  });
                  setNotice("镜像资料已接入，可查看组件并发起漏洞评估");
                  await refresh();
                  await props.onSelect({
                    containerId: result.version.containerId,
                    versionId: result.version.id,
                    sourceId: result.source.id,
                  });
                })
              }
            >
              接入镜像资料
            </button>
          </>
        )}
      </section>
      {props.mode === "host" && inventory && (
        <section className="panel">
          <div className="panel-heading">
            <h2>主机镜像目录</h2>
            <label className="container-inline">
              <input
                type="checkbox"
                checked={runningOnly}
                onChange={(e) => {
                  setRunningOnly(e.target.checked);
                  setSelected([]);
                }}
              />
              仅显示运行中容器使用的镜像
            </label>
          </div>
          <p>
            目录快照 {inventory.snapshotId} · 镜像 {inventory.imagesStatus} ·
            容器 {inventory.containersStatus}
          </p>
          {inventory.issues.map((v) => (
            <p key={v}>{v}</p>
          ))}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>选择</th>
                  <th>仓库 / 标签</th>
                  <th>Docker ImageID</th>
                  <th>容器</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.imageId}>
                    <td>
                      <input
                        aria-label={`选择镜像 ${i.repositories[0] ?? i.imageId}`}
                        type="checkbox"
                        checked={selected.includes(i.imageId)}
                        onChange={(e) => {
                          setSelected(
                            e.target.checked
                              ? [...selected, i.imageId]
                              : selected.filter((id) => id !== i.imageId),
                          );
                          key.current = requestId();
                        }}
                      />
                    </td>
                    <td>
                      {i.repositories.join(", ") || "来源未知"}
                      <small>{i.tags.join(", ") || "无标签"}</small>
                    </td>
                    <td>
                      <code>{i.imageId}</code>
                      <small>ImageID 与 manifest digest 分别表达</small>
                    </td>
                    <td>
                      {i.containers.length
                        ? i.containers.map((c) => (
                            <div key={c.containerId}>
                              {c.name} · {c.state}
                            </div>
                          ))
                        : "未发现运行容器关系"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && <p>没有符合条件的镜像；未知目录不代表空目录。</p>}
          {!profileId && (
            <p>
              当前没有选定已授权的在线连接。可切换“离线脚本”按固定 ImageID
              生成镜像 SBOM 后上传，目录上传不会授予在线访问权限。
            </p>
          )}
          <button
            className="primary"
            disabled={busy || !selected.length || !profileId}
            onClick={() =>
              void run(async () => {
                await call("/container-runtime/jobs", "POST", {
                  assetId,
                  profileId,
                  snapshotId: inventory.snapshotId,
                  imageIds: selected,
                  idempotencyKey: key.current,
                });
                await refresh();
                setNotice("生成并扫描任务已提交，关闭页面不影响后台执行");
              })
            }
          >
            生成并扫描所选镜像（{selected.length}）
          </button>
        </section>
      )}
      {!!jobs.length && (
        <section className="panel">
          <h2>生成与扫描任务</h2>
          <p>最近100项；每个镜像独立执行，部分失败不影响其他结果。</p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>镜像</th>
                  <th>进度</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <code>{j.imageId}</code>
                    </td>
                    <td>
                      {statuses[j.status]}
                      {!runtimeTerminal(j.status) && (
                        <progress aria-label="镜像任务进度" />
                      )}
                      {j.error && <p role="alert">{j.error}</p>}
                    </td>
                    <td>
                      {j.versionId && (
                        <button
                          onClick={() =>
                            void run(() =>
                              props.onSelect({
                                containerId: j.containerId!,
                                versionId: j.versionId!,
                                assessmentId: j.assessmentId ?? undefined,
                                sourceId: j.sourceId ?? undefined,
                              }),
                            )
                          }
                        >
                          查看镜像结果
                        </button>
                      )}
                      {runtimeTerminal(j.status) &&
                        j.status !== "succeeded" && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await call(
                                  `/container-runtime/jobs/${j.id}/retry`,
                                  "POST",
                                  { idempotencyKey: requestId() },
                                );
                                await refresh();
                              })
                            }
                          >
                            重试未成功任务
                          </button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {!!sources.length && (
        <section className="panel">
          <h2>主机与镜像来源</h2>
          <p>
            保留固定资料版本；镜像漏洞不自动等同主机或运行容器已确认受影响。
          </p>
          {sources.map((s) => (
            <div className="container-source" key={s.id}>
              <span>
                {s.basis === "docker_image_observation"
                  ? "Docker镜像观测"
                  : "操作员声明"}{" "}
                · {s.generator ?? "上传资料"} · {s.generatedAt ?? s.createdAt}
              </span>
              <button
                onClick={() =>
                  void run(() =>
                    props.onSelect({
                      containerId: s.containerId,
                      versionId: s.versionId,
                      sourceId: s.id,
                    }),
                  )
                }
              >
                查看来源版本
              </button>
              <small>
                {s.assetId ? `主机 ${s.assetId}` : "独立镜像"} ·{" "}
                {s.containers.length} 个关联容器
              </small>
            </div>
          ))}
        </section>
      )}
    </section>
  );
}
