import {
  HostImageAcquisition,
  type ImageSelection,
} from "./HostImageAcquisition";
import "./container-runtime.css";
import {
  ScanConditions,
  ScanConditionsHeading,
} from "../assessments/ScanConditions";
import { AssessmentHistoryTable } from "../assessments/AssessmentHistoryTable";
import {
  SeverityControls,
  defaultSeverities,
} from "../assessments/SeverityControls";
import { AssessmentLiveStatus } from "../assessments/AssessmentLiveStatus";
import { requestId } from "../../request-id";
import { useEffect, useRef, useState } from "react";
import type { FeatureProps } from "../../features";
import { api, ApiError } from "../../api";
import type {
  ContainerImage,
  ContainerDetail,
  ContainerVersion,
} from "../../../../../packages/contracts/containers";
import type { ImportMaterial } from "../../../../../packages/contracts";
import type {
  Assessment,
  AssessmentPage,
} from "../../../../../packages/contracts/assessments";
import {
  AssessmentDetails,
  assessmentStatusLabels,
} from "../assessments/AssessmentDetails";
import "../software/software.css";
export function ContainersPage({
  customerId,
  token,
  onUnauthorized,
  assessmentOnly = false,
  assetId,
  onNavigate,
  collectionContext,
}: FeatureProps & { assessmentOnly?: boolean }) {
  const sourceId = useRef<string | undefined>(undefined);
  const [entry, setEntry] = useState("host");
  const [items, setItems] = useState<ContainerImage[]>([]),
    [name, setName] = useState(""),
    [source, setSource] = useState(""),
    [image, setImage] = useState<ContainerDetail>(),
    [snapshot, setSnapshot] = useState<ContainerVersion>(),
    [material, setMaterial] = useState<ImportMaterial>(),
    [file, setFile] = useState<File>(),
    [claim, setClaim] = useState({
      repository: "",
      digest: "",
      tag: "",
      architecture: "",
    }),
    [history, setHistory] = useState<AssessmentPage>({
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
    }),
    [job, setJob] = useState<Assessment>(),
    [severities, setSeverities] = useState(defaultSeverities),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const controller = useRef(new AbortController()),
    selection = useRef<{ containerId: string; versionId: string } | undefined>(
      undefined,
    ),
    jobId = useRef<string | undefined>(undefined),
    key = useRef(requestId()),
    offset = useRef(0);
  const base = `/customers/${customerId}`;
  const call = <T,>(path: string, options: RequestInit = {}) =>
    api<T>(path, token, options, controller.current.signal);
  function fail(e: unknown) {
    if (controller.current.signal.aborted) return;
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  async function refresh() {
    try {
      setItems(
        (await call<{ items: ContainerImage[] }>(`${base}/containers`)).items,
      );
    } catch (e) {
      fail(e);
    }
  }
  async function refreshTasks() {
    const current = selection.current,
      pageOffset = offset.current;
    if (!current) return;
    try {
      const tasks = await call<AssessmentPage>(
        `${base}/assessments?targetKind=container&targetId=${current.containerId}&versionId=${current.versionId}&limit=20&offset=${pageOffset}`,
      );
      if (selection.current === current && offset.current === pageOffset)
        setHistory(tasks);
      const id = jobId.current;
      if (id) {
        const details = await call<Assessment>(`${base}/assessments/${id}`);
        if (selection.current === current && jobId.current === id)
          setJob(details);
      }
    } catch (e) {
      fail(e);
    }
  }
  useEffect(() => {
    controller.current = new AbortController();
    refresh();

    return () => {
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
  function clear() {
    sourceId.current = undefined;
    selection.current = undefined;
    jobId.current = undefined;
    setJob(undefined);
    setSnapshot(undefined);
    setMaterial(undefined);
    setHistory({ items: [], total: 0, limit: 20, offset: 0 });
    offset.current = 0;
    key.current = requestId();
  }
  async function chooseVersion(v: ContainerVersion) {
    sourceId.current = undefined;
    selection.current = { containerId: v.containerId, versionId: v.id };
    jobId.current = undefined;
    setJob(undefined);
    setSnapshot(v);
    setMaterial(undefined);
    offset.current = 0;
    key.current = requestId();
    setMaterial(await call<ImportMaterial>(`${base}/imports/${v.importId}`));
    await refreshTasks();
  }
  return (
    <section className="software-page">
      {!assessmentOnly && (
        <header className="page-header">
          <div>
            <p className="eyebrow">容器镜像资料</p>
            <h1>容器镜像</h1>
            <p>
              选择主机发现 Docker 镜像并生成扫描资料，也可手动上传 SBOM
              或使用离线脚本。按固定镜像输入版本评估。
            </p>
          </div>
        </header>
      )}
      {!assessmentOnly && (
        <HostImageAcquisition
          customerId={customerId}
          token={token}
          onUnauthorized={onUnauthorized}
          assetId={assetId}
          collectionContext={collectionContext}
          onNavigate={onNavigate}
          mode={entry}
          setMode={setEntry}
          onSelect={async (selected: ImageSelection) => {
            setEntry("manual");
            clear();
            setImage(
              await call<ContainerDetail>(
                `${base}/containers/${selected.containerId}`,
              ),
            );
            const v = await call<ContainerVersion>(
              `${base}/containers/${selected.containerId}/versions/${selected.versionId}`,
            );
            await chooseVersion(v);
            sourceId.current = selected.sourceId;
            if (selected.assessmentId) {
              jobId.current = selected.assessmentId;
              setJob(
                await call<Assessment>(
                  `${base}/assessments/${selected.assessmentId}`,
                ),
              );
            }
            await refresh();
          }}
        />
      )}
      {(assessmentOnly || entry === "manual") && (
        <>
          {!job?.result && (
            <SeverityControls value={severities} onChange={setSeverities} />
          )}
          <ScanConditions trivy>
            {assessmentOnly && (
              <p>
                选择已保存的镜像及固定 SBOM
                版本。新增镜像与上传资料请使用“容器镜像”入口。
              </p>
            )}
            {error && <p role="alert">{error}</p>}
            {message && <p role="status">{message}</p>}
          </ScanConditions>
          {!assessmentOnly && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  const created = await call<ContainerImage>(
                    `${base}/containers`,
                    {
                      method: "POST",
                      body: JSON.stringify({ name, source }),
                    },
                  );
                  clear();
                  setImage({ ...created, versions: [] });
                  setName("");
                  setSource("");
                  await refresh();
                });
              }}
            >
              <h2>建立镜像对象</h2>
              <label>
                镜像名称
                <input
                  required
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                />
              </label>
              <label>
                镜像资料来源
                <input
                  required
                  maxLength={200}
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  disabled={busy}
                />
              </label>
              <button disabled={busy}>建立镜像对象</button>
            </form>
          )}
          <ScanConditions trivy>
            <div className="panel">
              <ScanConditionsHeading standaloneLevel={2}>
                镜像对象
              </ScanConditionsHeading>
              {assessmentOnly ? (
                <label>
                  镜像对象
                  <select
                    aria-label="镜像对象"
                    value={image?.id ?? ""}
                    disabled={busy}
                    onChange={(e) => {
                      const id = e.target.value;
                      void run(async () => {
                        clear();
                        setImage(undefined);
                        if (id)
                          setImage(
                            await call<ContainerDetail>(
                              `${base}/containers/${id}`,
                            ),
                          );
                      });
                    }}
                  >
                    <option value="">选择已保存的镜像</option>
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : items.length === 0 ? (
                <p>暂无容器镜像</p>
              ) : (
                items.map((i) => (
                  <button
                    key={i.id}
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        clear();
                        setImage(
                          await call<ContainerDetail>(
                            `${base}/containers/${i.id}`,
                          ),
                        );
                      })
                    }
                  >
                    {i.name}
                  </button>
                ))
              )}
            </div>
            {image && (
              <div className="panel">
                <ScanConditionsHeading>{image.name}</ScanConditionsHeading>
                <p>
                  来源：{image.source} · 镜像对象编号：{image.id}
                </p>
                {!assessmentOnly && (
                  <>
                    <label>
                      容器 SBOM 文件
                      <input
                        type="file"
                        accept=".json,application/json"
                        disabled={busy}
                        onChange={(e) => setFile(e.target.files?.[0])}
                      />
                    </label>
                    <details>
                      <summary>补充镜像身份（可选，不能与 SBOM 矛盾）</summary>
                      {(
                        ["repository", "digest", "tag", "architecture"] as const
                      ).map((field, i) => (
                        <label key={field}>
                          {
                            ["仓库地址", "镜像 digest", "镜像标签", "镜像架构"][
                              i
                            ]
                          }
                          <input
                            value={claim[field]}
                            onChange={(e) =>
                              setClaim({ ...claim, [field]: e.target.value })
                            }
                            disabled={busy}
                          />
                        </label>
                      ))}
                    </details>
                    <button
                      disabled={busy || !file}
                      onClick={() =>
                        run(async () => {
                          if (!file) return;
                          if (file.size > 20000000)
                            throw Error("SBOM 文件最多20000000字节");
                          const content = new TextDecoder("utf-8", {
                            fatal: true,
                            ignoreBOM: true,
                          }).decode(await file.arrayBuffer());
                          const identities = Object.fromEntries(
                            Object.entries(claim)
                              .filter(([, value]) => value.trim())
                              .map(([k, v]) => [k, v.trim()]),
                          );
                          const v = await call<ContainerVersion>(
                            `${base}/containers/${image.id}/sbom`,
                            {
                              method: "POST",
                              body: JSON.stringify({
                                fileName: file.name,
                                content,
                                ...identities,
                              }),
                            },
                          );
                          setImage(
                            await call<ContainerDetail>(
                              `${base}/containers/${image.id}`,
                            ),
                          );
                          await chooseVersion(v);
                          setMessage(
                            v.replayed
                              ? "重复资料：回读原镜像输入版本"
                              : "镜像 SBOM 已保存为独立输入版本",
                          );
                        })
                      }
                    >
                      上传镜像 SBOM
                    </button>
                    <p>
                      标签可以变化；digest
                      缺失时仍可接入，但身份保持未知。新的资料保留独立快照。
                    </p>
                  </>
                )}
                {assessmentOnly ? (
                  <label>
                    镜像输入版本
                    <select
                      aria-label="镜像输入版本"
                      value={snapshot?.id ?? ""}
                      disabled={busy}
                      onChange={(e) => {
                        const version = image.versions.find(
                          (v) => v.id === e.target.value,
                        );
                        if (version) void run(() => chooseVersion(version));
                        else clear();
                      }}
                    >
                      <option value="">选择固定 SBOM 版本</option>
                      {image.versions.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.identity.tag ?? "标签未知"} · {v.createdAt} ·{" "}
                          {v.id.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                    {!image.versions.length && (
                      <p>没有镜像输入版本，请先在容器镜像入口上传 SBOM。</p>
                    )}
                  </label>
                ) : (
                  <>
                    <h3>镜像输入版本历史</h3>
                    {image.versions.map((v) => (
                      <button
                        key={v.id}
                        disabled={busy}
                        onClick={() => run(() => chooseVersion(v))}
                      >
                        镜像版本 {v.identity.tag ?? "标签未知"} ·{" "}
                        {v.id.slice(0, 8)}
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </ScanConditions>
          {snapshot && (
            <>
              <div className="panel">
                <h2>镜像详情与组件</h2>
                <p>输入版本编号：{snapshot.id}</p>
                <p>
                  镜像仓库：{snapshot.identity.repository ?? "未知"} · 标签：
                  {snapshot.identity.tag ?? "未知"}
                </p>
                <p>
                  SBOM 声明版本：{snapshot.declaredVersion ?? "未知"} · Digest：
                  {snapshot.identity.digest ?? "未知"} · 架构：
                  {snapshot.identity.architecture ?? "未知"}
                </p>
                <p>
                  身份依据：{snapshot.identity.basis} · 采集时间：
                  {snapshot.collectedAt ?? "未知"}
                </p>
                {snapshot.issues.map((i) => (
                  <p key={i}>{i}</p>
                ))}
                <h3>操作系统</h3>
                {snapshot.operatingSystems.length ? (
                  snapshot.operatingSystems.map((o) => (
                    <p key={o.componentId}>
                      {o.name} · {o.version ?? "版本未知"} ·{" "}
                      {o.cpe ?? "CPE未知"}
                    </p>
                  ))
                ) : (
                  <p>操作系统来源未知，不能推断发行版。</p>
                )}
                <h3>镜像组件</h3>
                <table>
                  <thead>
                    <tr>
                      <th>组件</th>
                      <th>安装版本 / 包生态</th>
                      <th>身份与来源</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.components.map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td>
                          {c.version ?? "未知"} · {c.ecosystem ?? "生态未知"}
                        </td>
                        <td>
                          <p>{c.purl ?? c.cpe ?? "身份未知"}</p>
                          {c.issues.map((i) => (
                            <p key={i}>{i}</p>
                          ))}
                          <details>
                            <summary>组件原始资料</summary>
                            <pre>{JSON.stringify(c.raw, null, 2)}</pre>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {material && (
                  <>
                    <p>
                      来源资料：{material.id} · SHA-256：{material.contentHash}
                    </p>
                    <details>
                      <summary>原始镜像 SBOM</summary>
                      <pre>{material.content}</pre>
                    </details>
                  </>
                )}
              </div>
              <ScanConditions trivy>
                <div className="panel">
                  <ScanConditionsHeading>镜像漏洞评估</ScanConditionsHeading>
                  <p>
                    当前输入：{image?.name} ·{" "}
                    {snapshot.identity.tag ?? "标签未知"} · {snapshot.id}
                  </p>
                  <p>只评估当前镜像输入版本；发现不自动归属于运行实例。</p>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const task = await call<Assessment>(
                          `${base}/assessments`,
                          {
                            method: "POST",
                            body: JSON.stringify({
                              containerId: snapshot.containerId,
                              versionId: snapshot.id,
                              idempotencyKey: key.current,
                              ...(sourceId.current
                                ? { containerSourceId: sourceId.current }
                                : {}),
                            }),
                          },
                        );
                        jobId.current = task.id;
                        setJob(task);
                        await refreshTasks();
                        setMessage(
                          task.replayed
                            ? "重复请求：回读原镜像任务"
                            : "镜像评估已提交，后台执行",
                        );
                      })
                    }
                  >
                    评估当前镜像版本
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      key.current = requestId();
                      setMessage("已建立新镜像评估请求，提交后独立执行");
                    }}
                  >
                    新建镜像评估请求
                  </button>
                </div>
              </ScanConditions>
            </>
          )}
          {job && (
            <AssessmentLiveStatus
              customerId={customerId}
              token={token}
              onUnauthorized={onUnauthorized}
              jobId={job.id}
              onComplete={refreshTasks}
            />
          )}
          {job && (
            <AssessmentDetails
              context={{ customerId, token, onUnauthorized }}
              selectedSeverities={severities}
              onSeveritiesChange={setSeverities}
              job={job}
            />
          )}
          {snapshot && (
            <div className="panel">
              <h3>镜像评估历史</h3>
              <p>本输入版本有 {history.total} 个评估任务</p>
              <AssessmentHistoryTable
                items={history.items}
                job={job}
                busy={busy}
                prefix="镜像评估 "
                onSelect={(id) =>
                  void run(async () => {
                    jobId.current = id;
                    setJob(await call<Assessment>(`${base}/assessments/${id}`));
                  })
                }
              />
              <div>
                <button
                  disabled={busy || offset.current === 0}
                  onClick={() => {
                    offset.current = Math.max(0, offset.current - 20);
                    refreshTasks();
                  }}
                >
                  上一页评估
                </button>
                <button
                  disabled={
                    busy || history.offset + history.limit >= history.total
                  }
                  onClick={() => {
                    offset.current += 20;
                    refreshTasks();
                  }}
                >
                  下一页评估
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
