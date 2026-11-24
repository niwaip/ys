import {
  AssetConfiguration,
  type SubmittedObservation,
} from "./AssetConfiguration";
import { ConfigurationMaterials } from "./ConfigurationMaterials";
import type { ConfigurationContent } from "../../../../../packages/contracts/collection-configuration";
import { WindowsCollectionPreview } from "./WindowsCollectionPreview";
import { NewCollectionAsset } from "./NewCollectionAsset";
import { categoryForAsset } from "./device-category";
import { DeviceFields } from "./DeviceFields";
import {
  deviceCategories,
  deviceFields,
  type DeviceCategory,
} from "../../../../../packages/contracts/device-collection";
import { AssetBaseline } from "./AssetBaseline";
import "./collections.css";
import "./collection-workbench.css";
import { ConnectionEditor } from "./ConnectionEditor";
import { VersionLinks } from "./VersionLinks";
import { useEffect, useState, useRef, type FormEvent } from "react";
import type { Asset, AssetPage } from "../../../../../packages/contracts";
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
type Profile = {
  id: string;
  label: string;
  assetId: string;
  scopes: string[];
  host?: string;
  transport?: string;
  credentialName?: string;
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
  assetId,
  onNavigate,
  collectionContext,
}: FeatureProps) {
  const completedJobs = useRef(new Set<string>());
  const [assets, setAssets] = useState<AssetPage>();
  const [targetAsset, setTargetAsset] = useState<Asset>();
  const [target, setTarget] = useState(assetId ?? "");
  const [tab, setTab] = useState("connect");
  const [profileId, setProfileId] = useState("");
  const [editingConnection, setEditingConnection] = useState(false);
  const [usePi, setUsePi] = useState(false);
  const [historyTab, setHistoryTab] = useState("records");
  const [category, setCategory] = useState<DeviceCategory>("other");
  const [roleMappings, setRoleMappings] = useState<
    Record<string, DeviceCategory>
  >({});
  const [platform, setPlatform] = useState("linux");
  const [showBaseline, setShowBaseline] = useState(false);
  useEffect(() => {
    setShowBaseline(false);
  }, [target]);
  const [addingAsset, setAddingAsset] = useState(false);
  const [typeFilter, setTypeFilter] = useState<DeviceCategory | "">("");
  const [activeContent, setActiveContent] = useState<ConfigurationContent>(
    collectionContext?.configurationContent ?? "basic",
  );
  const [scope, setScope] = useState(
    collectionContext?.configurationContent === "docker"
      ? "container-inventory"
      : "basic",
  );
  const [capability, setCapability] =
    useState<
      import("../../../../../packages/contracts/collections").CollectionCapabilities
    >();
  const [historyScope, setHistoryScope] = useState("all");
  const [assetOffset, setAssetOffset] = useState(0);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [snapshots, setSnapshots] = useState<{
    items: CollectionSnapshot[];
    total: number;
  }>();
  const [offset, setOffset] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<CollectionSnapshot>();
  const [submittedObservation, setSubmittedObservation] =
    useState<SubmittedObservation>();
  const [raw, setRaw] = useState<string>();
  const [scrollToResult, setScrollToResult] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [jobKey, setJobKey] = useState(requestId);
  const [currentJob, setCurrentJob] = useState<Job>();
  const feedback = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  const selection = `${customerId}:${target}:${profileId}:${scope}:${category}:${platform}:${activeContent}`;
  const currentSelection = useRef(selection);
  currentSelection.current = selection;
  const collecting =
    !!currentJob && ["queued", "running"].includes(currentJob.status);
  useEffect(() => {
    setCurrentJob(undefined);
    setSelected(undefined);
    setNotice("");
    setRaw(undefined);
    setContent("");
    setFileName("");
    setError("");
  }, [target, profileId, scope, customerId]);
  useEffect(() => {
    if (notice || error || currentJob || busy)
      feedback.current?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
  }, [notice, error, currentJob?.id, currentJob?.status, busy]);
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState("");
  const fileRevision = useRef(0);
  const selectedSnapshotId = useRef(selected?.id);
  selectedSnapshotId.current = selected?.id;
  useEffect(() => {
    fileRevision.current++;
    setContent("");
    setFileName("");
  }, [tab, target, scope, platform, category]);
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
        `/customers/${customerId}/assets?limit=100&offset=${assetOffset}${typeFilter ? `&category=${typeFilter}` : ""}`,
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
        `${base}/snapshots?limit=20&offset=${offset}${historyScope === "all" ? "" : `&scope=${historyScope}`}`,
        token,
        {},
        controller.signal,
      ),
    ])
      .then(([assets, profiles, snapshots]) => {
        if (controller.signal.aborted) return;
        setAssets(assets);
        setTarget((old) => old || assets.items[0]?.id || "");
        setProfiles(profiles.items);
        setSnapshots(snapshots);
      })
      .catch((e) => {
        if (!controller.signal.aborted) fail(e);
      });
    return () => controller.abort();
  }, [
    base,
    token,
    revision,
    offset,
    historyScope,
    assetOffset,
    typeFilter,
    onUnauthorized,
  ]);
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
        setCurrentJob((current) =>
          current
            ? (result.items.find((job) => job.id === current.id) ?? current)
            : undefined,
        );
        const completed = result.items.filter(
          (job) => job.snapshotId && !completedJobs.current.has(job.id),
        );
        if (completed.length) {
          completed.forEach((job) => completedJobs.current.add(job.id));
          setRevision((value) => value + 1);
        }
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
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || collecting) return;
    if (!asset || (tab === "connect" && !linuxSupported)) {
      setError("请先选择有效资产及适用的采集方式");
      return;
    }
    submitting.current = true;
    const submittedSelection = selection;
    const submittedContent = activeContent;
    setRaw(undefined);
    setCurrentJob(undefined);
    setBusy(true);
    setError("");
    setNotice(tab === "connect" ? "正在提交采集任务…" : "");
    setSelected(undefined);
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
                ...(deviceFields(category).some((field) =>
                  values.get(`device.${field}`),
                )
                  ? {
                      device: {
                        status: "acquired",
                        data: {
                          category,
                          ...Object.fromEntries(
                            deviceFields(category).map((field) => [
                              field,
                              String(values.get(`device.${field}`) || "") ||
                                null,
                            ]),
                          ),
                        },
                      },
                    }
                  : {}),
                os: {
                  status: hasOs ? "acquired" : "not_collected",
                  data: hasOs ? os : null,
                },
              },
              extensions: {},
            },
          }),
        });
        if (currentSelection.current !== submittedSelection) return;
        setScrollToResult(true);
        setSelected(saved);
        setSubmittedObservation({
          snapshotId: saved.id,
          content: submittedContent,
          eventId: requestId(),
        });
        setNotice("人工来源快照已保存，尚未评估");
      } else if (tab === "upload") {
        const saved = await api<CollectionSnapshot>(`${base}/upload`, token, {
          method: "POST",
          body: JSON.stringify({ assetId: target, fileName, content, scope }),
        });
        if (currentSelection.current !== submittedSelection) return;
        setScrollToResult(true);
        setSelected(saved);
        setSubmittedObservation({
          snapshotId: saved.id,
          content: submittedContent,
          eventId: requestId(),
        });
        setNotice("原始资料与快照已保存，尚未评估");
      } else {
        const job = await api<Job>(`${base}/jobs`, token, {
          method: "POST",
          body: JSON.stringify({
            assetId: target,
            idempotencyKey: jobKey,
            profileId,
            method: usePi ? "pi" : "ssh",
            scope,
            message: String(
              values.get("message") ||
                (scope === "basic" ? "主机基础采集" : "容器目录发现"),
            ),
          }),
        });
        if (currentSelection.current !== submittedSelection) return;
        setCurrentJob(job);
        setNotice("");
        setJobKey(requestId());
        setHistoryTab("tasks");
      }
      setRevision((x) => x + 1);
    } catch (e) {
      setNotice("");
      fail(e);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (currentJob?.snapshotId) void showSnapshot(currentJob.snapshotId, false);
  }, [currentJob?.id, currentJob?.snapshotId]);
  const inlineResult = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected && scrollToResult)
      inlineResult.current?.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
  }, [selected, scrollToResult]);
  async function showSnapshot(id: string, scroll = true) {
    try {
      const requestedSelection = currentSelection.current;
      const snapshot = await api<CollectionSnapshot>(
        `${base}/snapshots/${id}`,
        token,
      );
      if (requestedSelection !== currentSelection.current) return;
      setScrollToResult(scroll);
      setSelected(snapshot);
      if (snapshot.scope === "container-inventory") setNotice("");
      setRaw(undefined);
    } catch (e) {
      fail(e);
    }
  }
  async function readRawSnapshot(id: string) {
    const requestedSelection = currentSelection.current;
    try {
      const result = await api<{ content: string }>(
        `${base}/snapshots/${id}/raw`,
        token,
      );
      if (
        requestedSelection === currentSelection.current &&
        selectedSnapshotId.current === id
      )
        setRaw(result.content);
    } catch (e) {
      if (requestedSelection === currentSelection.current) fail(e);
    }
  }
  const listedAsset = assets?.items.find((item) => item.id === target);
  const asset =
    listedAsset ?? (targetAsset?.id === target ? targetAsset : undefined);
  useEffect(() => {
    if (listedAsset) {
      setTargetAsset(listedAsset);
      return;
    }
    if (!target) return;
    const controller = new AbortController();
    api<Asset>(
      `/customers/${customerId}/assets/${target}`,
      token,
      {},
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setTargetAsset(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setTargetAsset(undefined);
          fail(e);
        }
      });
    return () => controller.abort();
  }, [target, listedAsset, customerId, token]);
  useEffect(() => {
    const controller = new AbortController();
    api<{ mappings: Record<string, DeviceCategory> }>(
      `${base}/role-templates`,
      token,
      {},
      controller.signal,
    )
      .then((v) => {
        if (!controller.signal.aborted) setRoleMappings(v.mappings);
      })
      .catch((e) => {
        if (!controller.signal.aborted) fail(e);
      });
    return () => controller.abort();
  }, [base, token]);
  useEffect(() => {
    if (!asset) return;
    const classified = categoryForAsset(asset, roleMappings);
    setCategory(classified);
    if (!["server", "vm"].includes(classified)) {
      setActiveContent("basic");
      setScope("basic");
    }
    const platformName = JSON.stringify(
      asset.attributes.platform ?? "",
    ).toLowerCase();
    setPlatform(platformName.includes("windows") ? "windows" : "linux");
  }, [asset?.id, roleMappings]);
  const hostType =
    ["server", "vm"].includes(category) ||
    (category === "other" && asset?.source !== "netbox");
  const linuxSupported = hostType && platform === "linux";
  useEffect(() => {
    if (!linuxSupported) {
      setScope("basic");
      if (tab === "connect" || tab === "offline") setTab("manual");
    }
  }, [linuxSupported]);
  const availableProfiles = profiles.filter((item) => item.assetId === target);
  const selectedProfile = availableProfiles.find(
    (item) => item.id === profileId,
  );
  useEffect(() => {
    setProfileId((old) =>
      profiles.some((item) => item.assetId === target && item.id === old)
        ? old
        : (profiles.find((item) => item.assetId === target)?.id ?? ""),
    );
  }, [target, profiles]);
  useEffect(() => {
    setCapability(undefined);
  }, [target, profileId, scope, platform]);
  async function checkCapabilities() {
    setBusy(true);
    setError("");
    try {
      setCapability(
        await api(`${base}/capabilities`, token, {
          method: "POST",
          body: JSON.stringify({ assetId: target, profileId, scope }),
        }),
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function downloadScript() {
    setBusy(true);
    setError("");
    try {
      const script = await api<{ fileName: string; content: string }>(
        `${base}/script?scope=${scope}&platform=${platform}${target ? `&assetId=${target}` : ""}`,
        token,
      );
      const url = URL.createObjectURL(
        new Blob([script.content], { type: "text/javascript" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = script.fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  const capabilityLabels: Record<
    import("../../../../../packages/contracts/collections").CapabilityStatus,
    string
  > = {
    unchecked: "未检查",
    unauthorized: "未授权",
    tool_missing: "工具缺失",
    access_failed: "访问失败",
    available: "可用",
  };
  const directoryAuthorized = Boolean(
    selectedProfile?.scopes.includes("container-inventory"),
  );
  const address = String(
    asset?.attributes.primaryIp4 ?? asset?.attributes.ip ?? "",
  ).split("/")[0];
  const active = jobs.filter((job) =>
    ["queued", "running"].includes(job.status),
  ).length;
  return (
    <div className="collection-page collection-console">
      <header className="collect-heading">
        <div>
          <span className="collect-kicker">资产与证据</span>
          <h1>资产采集</h1>
          <p>选择目标与采集内容，确认取得的资料后再更新资产基线。</p>
        </div>
        <div className="collect-live">
          <span />
          多类型设备 · 资料采集
        </div>
      </header>
      <section className="collect-metrics" aria-label="采集概览">
        <div>
          <span>纳管资产</span>
          <strong>{assets?.total ?? "—"}</strong>
        </div>
        <div>
          <span>采集记录</span>
          <strong>{snapshots?.total ?? "—"}</strong>
        </div>
        <div>
          <span>进行中的任务</span>
          <strong>{active}</strong>
        </div>
      </section>
      <section className="collect-card collect-setup" aria-label="采集配置">
        <div className="collect-card-heading">
          <div>
            <h2>采集配置</h2>
            <p>选择目标资产、适用资料与接入方式。</p>
          </div>
          <span className="collect-step">配置 → 采集 → 确认</span>
        </div>
        <section className="asset-kind-choices" aria-label="资产类型">
          <h3>01 · 选择资产类型</h3>
          <div>
            {Object.entries(deviceCategories).map(([key, label]) => (
              <button
                type="button"
                className="secondary"
                key={key}
                disabled={busy}
                aria-pressed={typeFilter === key}
                onClick={() => {
                  setTypeFilter(key as DeviceCategory);
                  setTarget("");
                  setAssetOffset(0);
                  setActiveContent("basic");
                  setScope("basic");
                  setCategory(key as DeviceCategory);
                }}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => setTypeFilter("")}
            >
              全部类型
            </button>
          </div>
        </section>
        <div className="collect-target collect-shared-target">
          <div className="collect-identity">
            <label>
              目标资产
              <select
                aria-label="目标资产"
                disabled={busy}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">选择资产</option>
                {asset && !listedAsset && (
                  <option value={asset.id}>{asset.name}</option>
                )}
                {assets?.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.attributes.primaryIp4 || item.attributes.ip
                      ? ` · ${item.attributes.primaryIp4 ?? item.attributes.ip}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => setAddingAsset(true)}
            >
              ＋ 新增资产
            </button>
            <label>
              设备资料类型
              <select
                aria-label="设备资料类型"
                value={category}
                disabled={
                  busy ||
                  (
                    asset?.attributes.netbox as
                      { objectType?: string } | undefined
                  )?.objectType === "virtual-machine"
                }
                onChange={(e) => {
                  const value = e.target.value as DeviceCategory;
                  setCategory(value);
                  if (!["server", "vm"].includes(value)) {
                    setActiveContent("basic");
                    setScope("basic");
                  }
                }}
              >
                {Object.entries(deviceCategories).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {!!(asset?.attributes.role as { id?: number } | undefined)?.id &&
              category !== "vm" && (
                <button
                  type="button"
                  className="text-button"
                  onClick={async () => {
                    try {
                      const v = await api<{
                        mappings: Record<string, DeviceCategory>;
                      }>(`${base}/role-templates`, token, {
                        method: "POST",
                        body: JSON.stringify({
                          roleId: (asset!.attributes.role as { id: number }).id,
                          category,
                        }),
                      });
                      setRoleMappings(v.mappings);
                      setNotice("已保存该NetBox角色的表单映射");
                    } catch (e) {
                      fail(e);
                    }
                  }}
                >
                  将此表单用于同角色设备
                </button>
              )}
            <p className="collect-muted">
              主数据来源：
              {asset?.source === "netbox"
                ? "NetBox · 角色、型号及平台"
                : "本地资产"}
              。设备类别与操作系统分别选择。
            </p>
            {assets && assets.total > 100 && (
              <details className="collect-host-pages">
                <summary>
                  更多主机 · 当前第 {Math.floor(assetOffset / 100) + 1} 批
                </summary>
                <div className="pagination">
                  <button
                    type="button"
                    disabled={!assetOffset}
                    onClick={() =>
                      setAssetOffset(Math.max(0, assetOffset - 100))
                    }
                  >
                    上一批主机
                  </button>
                  <button
                    type="button"
                    disabled={assetOffset + 100 >= assets.total}
                    onClick={() => setAssetOffset(assetOffset + 100)}
                  >
                    下一批主机
                  </button>
                </div>
              </details>
            )}
            {asset ? (
              <div className="collect-host">
                <span className="collect-host-icon" aria-hidden="true">
                  ▦
                </span>
                <div>
                  <p>{address || "未登记管理地址"}</p>
                  <details>
                    <summary>资产详情</summary>
                    <code>{asset.id}</code>
                    <p>来源：{asset.source}</p>
                    {asset.source === "netbox" && (
                      <>
                        <p>
                          角色：
                          {String(
                            (
                              asset.attributes.role as
                                { name?: string } | undefined
                            )?.name ?? "未登记",
                          )}{" "}
                          · 型号：
                          {String(
                            (
                              asset.attributes.deviceType as
                                { model?: string } | undefined
                            )?.model ?? "未登记",
                          )}
                        </p>
                        <p>
                          平台：
                          {String(
                            (
                              asset.attributes.platform as
                                { name?: string } | undefined
                            )?.name ?? "未登记",
                          )}{" "}
                          · 同步时间：
                          {String(
                            (
                              asset.attributes.netbox as
                                { syncedAt?: string } | undefined
                            )?.syncedAt ?? "未知",
                          )}
                        </p>
                      </>
                    )}
                  </details>
                </div>
                <span className="collect-pill">已选择资产</span>
              </div>
            ) : (
              <div className="collect-empty">
                <span>▥</span>
                <h3>先选择一项资产</h3>
                <p>在资产台账登记后，即可关联访问凭证并开始采集。</p>
              </div>
            )}
          </div>
        </div>
        {asset && (
          <details
            className="confirmed-configuration"
            onToggle={(e) => setShowBaseline(e.currentTarget.open)}
          >
            <summary>查看已确认的操作系统与基础配置</summary>
            {showBaseline && (
              <AssetBaseline
                customerId={customerId}
                token={token}
                onUnauthorized={onUnauthorized}
                assetId={target}
                readOnly
              />
            )}
          </details>
        )}
        <div hidden={!asset}>
          {asset && (
            <AssetConfiguration
              key={target}
              customerId={customerId}
              token={token}
              onUnauthorized={onUnauthorized}
              assetId={target}
              category={category}
              platform={platform as "linux" | "windows"}
              active={activeContent}
              submittedObservation={submittedObservation}
              onRestore={(value) => {
                setCategory(value.category);
                setPlatform(value.platform);
              }}
              onContent={(value) => {
                setActiveContent(value);
                setScope(value === "docker" ? "container-inventory" : "basic");
              }}
              onMethod={(method) =>
                setTab(
                  method === "automatic"
                    ? "connect"
                    : method === "script"
                      ? "upload"
                      : "manual",
                )
              }
            />
          )}
          {activeContent === "software" && (
            <section className="software-configuration">
              <h3>软件清单与组件资料分别保存</h3>
              <p>
                自动清单包含系统包及可直接取得的软件版本；不表示已发现所有应用依赖。可在下方录入版本或上传清单，再按明确应用路径取得组件资料。
              </p>
            </section>
          )}
          <div
            className="collect-access"
            hidden={tab !== "connect" || !linuxSupported}
          >
            <div className="collect-label-row">
              <label htmlFor="collection-connection">
                主机连接{" "}
                <span
                  className="collect-tip"
                  tabIndex={0}
                  title="连接将主机地址、登录账号和凭证关联起来。基础采集只执行固定读取命令，不要求目标安装Trivy。"
                >
                  ⓘ
                </span>
              </label>
              <button
                type="button"
                className="text-button"
                disabled={!target}
                onClick={() => setEditingConnection(true)}
              >
                ＋ 新建连接
              </button>
            </div>
            <select
              id="collection-connection"
              disabled={busy}
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              required
            >
              <option value="">选择已关联的连接</option>
              {availableProfiles.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            {selectedProfile ? (
              <div className="collect-connection-summary">
                <span className="collect-configured-dot" />
                <div>
                  <strong>
                    {selectedProfile.transport === "local"
                      ? `YS 部署主机 · ${selectedProfile.host ?? "本机"}`
                      : selectedProfile.host || "SSH访问"}
                  </strong>
                  <p>{selectedProfile.credentialName ?? "已关联访问凭证"}</p>
                </div>
                <span className="collect-pill">
                  {selectedProfile.transport === "local" ? "本机身份" : "SSH"}
                </span>
              </div>
            ) : (
              <div className="collect-connection-empty">
                <span>⌁</span>
                <div>
                  <strong>还没有关联连接</strong>
                  <p>新建连接，选择或保存一项登录凭证。</p>
                </div>
              </div>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy || !profileId || !target}
              onClick={() => void checkCapabilities()}
            >
              检查采集能力
            </button>
            {selectedProfile && !capability && (
              <p className="collect-muted">尚未检查连接与采集能力。</p>
            )}
            <details className="collect-access-help">
              <summary>执行位置说明</summary>
              <p className="collect-muted">
                本机执行指 YS
                部署主机，不是浏览器所在电脑。连接由部署端登记并限定客户与资产。
              </p>
            </details>
          </div>
          {capability && tab === "connect" && (
            <div
              className="collect-capabilities"
              role="region"
              aria-label="采集能力检查"
            >
              <strong>
                {capability.hostname} · {capability.identity ?? "身份未取得"}
              </strong>
              <p>
                检查于 {new Date(capability.checkedAt).toLocaleString()} ·{" "}
                {capability.transport === "local"
                  ? "YS 部署主机"
                  : "SSH 目标主机"}
              </p>
              <dl>
                {[
                  ["主机基础访问", capability.basic],
                  ["Docker 目录访问", capability.docker],
                  ["Trivy 镜像生成", capability.trivy],
                ].map(([label, check]) => (
                  <div key={String(label)}>
                    <dt>{String(label)}</dt>
                    <dd>
                      {
                        capabilityLabels[
                          (
                            check as import("../../../../../packages/contracts/collections").CapabilityCheck
                          ).status
                        ]
                      }
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          <div className="collect-workspace collect-task-workspace">
            <form
              className={`collect-input collect-mode-${tab}`}
              onSubmit={submit}
              key={`${tab}:${target}:${category}:${platform}`}
            >
              <p className="collect-muted">
                单项操作 ·{" "}
                {activeContent === "software"
                  ? "软件清单"
                  : scope === "basic"
                    ? "基础资料"
                    : "Docker目录"}
                。下方临时操作不改变上方已保存的批次配置。
              </p>
              <div
                className="collect-methods collect-entry-groups"
                role="tablist"
                aria-label="资料接入方式"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab !== "manual"}
                  onClick={() => setTab(linuxSupported ? "connect" : "upload")}
                >
                  自动／脚本采集
                </button>
                {scope === "basic" && (
                  <button
                    type="button"
                    role="tab"
                    aria-label="手动输入"
                    aria-selected={tab === "manual"}
                    onClick={() => setTab("manual")}
                  >
                    手动输入
                  </button>
                )}
              </div>
              {tab !== "manual" && (
                <div className="collect-auto-options">
                  {scope === "basic" && hostType && (
                    <label>
                      目标平台
                      <select
                        aria-label="目标平台"
                        value={platform}
                        onChange={(e) => {
                          setPlatform(e.target.value);
                          setTab(
                            e.target.value === "windows" ? "upload" : "connect",
                          );
                          setContent("");
                          setFileName("");
                        }}
                      >
                        <option value="linux">Linux</option>
                        <option value="windows">Windows</option>
                      </select>
                    </label>
                  )}
                  <div
                    className="collect-methods"
                    role="tablist"
                    aria-label="自动采集方式"
                  >
                    {[
                      ...(linuxSupported ? [["connect", "连接采集"]] : []),
                      ["upload", "上传脚本结果"],
                      ...(hostType ? [["offline", "离线脚本"]] : []),
                    ].map(([key, label]) => (
                      <button
                        type="button"
                        role="tab"
                        aria-label={label}
                        aria-selected={tab === key}
                        key={key}
                        onClick={() => setTab(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {!linuxSupported && (
                    <p className="notice">
                      {hostType
                        ? "Windows目前支持脚本结果上传，不支持远程执行。"
                        : "该类设备暂不支持连接采集；可上传ys-host/1设备资料或手动输入。SNMP v3将在后续阶段提供。"}
                    </p>
                  )}
                </div>
              )}
              {tab === "connect" ? (
                <>
                  <div className="collect-scope">
                    <div>
                      <strong>
                        {scope === "basic" ? "基础采集" : "容器 / 镜像目录"}
                      </strong>
                      <span
                        className="collect-tip"
                        tabIndex={0}
                        title={
                          scope === "basic"
                            ? "读取操作系统、运行内核、安装包和可见硬件/网络信息。不访问 Docker 引擎，不扫描容器内部或应用目录。"
                            : "单独读取容器和镜像目录及其关系，不扫描镜像内部组件。"
                        }
                      >
                        ⓘ
                      </span>
                    </div>
                    <p>
                      {scope === "basic"
                        ? "操作系统 · 安装包 · 硬件 · 网络"
                        : "容器实例 · 镜像身份 · 关联关系"}
                    </p>
                  </div>
                  {scope === "container-inventory" && !directoryAuthorized && (
                    <p className="notice">
                      该连接未授权 Docker
                      访问。请在连接管理中配置已授权连接；也可下载离线脚本后上传结果。
                    </p>
                  )}
                  {scope === "container-inventory" && (
                    <p className="collect-muted">
                      目录发现不要求 Trivy；生成镜像组件资料时才需要 Trivy。
                    </p>
                  )}
                  <details className="collect-options">
                    <summary>高级采集选项</summary>
                    <label className="collect-check">
                      <input
                        type="checkbox"
                        checked={usePi}
                        onChange={(e) => setUsePi(e.target.checked)}
                      />
                      使用Pi Agent协助{" "}
                      <span
                        className="collect-tip"
                        title="Pi只调用固定采集工具，需要服务器已配置Pi。基础采集可以直接执行。"
                        tabIndex={0}
                      >
                        ⓘ
                      </span>
                    </label>
                    {usePi && (
                      <label>
                        采集需求
                        <textarea
                          name="message"
                          defaultValue="取得所选范围的基础资料，披露读取缺口。"
                          maxLength={4000}
                          rows={2}
                        />
                      </label>
                    )}
                  </details>
                </>
              ) : tab === "offline" ? (
                <section className="collect-offline">
                  {platform === "windows" && (
                    <p>
                      在目标Windows上运行下载的PowerShell脚本：
                      <code>powershell -File .\\ys-windows.ps1</code>，生成
                      windows-collection.json
                      后上传。仅执行只读查询，不更改执行策略。
                    </p>
                  )}
                  <h3>
                    {scope === "basic"
                      ? "主机基础资料离线脚本"
                      : "容器目录离线脚本"}
                  </h3>
                  <p hidden={platform === "windows"}>
                    在目标 Linux 主机准备 Node.js；基础脚本无需
                    Docker，容器目录脚本需要 Docker 读取权限，两者均不要求
                    Trivy。
                  </p>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void downloadScript()}
                  >
                    下载{scope === "basic" ? "基础" : "容器目录"}采集脚本
                  </button>
                  <code hidden={platform === "windows"}>
                    node ys-
                    {scope === "basic" ? "host-basic" : "docker-inventory"}.mjs
                    &gt; collection.json
                  </code>
                  <p>
                    不安装、不提权、不拉取镜像。执行后选择“上传脚本结果”，确认资料属于当前目标主机。
                  </p>
                </section>
              ) : tab === "upload" ? (
                <>
                  <h3>上传采集资料</h3>
                  <p className="collect-muted">
                    支持 Linux ys-host/1、Windows
                    windows-bat/1，以及包含设备资料区块的 ys-host/1
                    JSON；软件与镜像SBOM在对应功能上传。
                    <span
                      className="collect-tip"
                      tabIndex={0}
                      title="支持ys-host/1 JSON，最多5MB、50000条包记录；超限明确拒绝，不会截断。"
                    >
                      ⓘ
                    </span>
                  </p>
                  <label className="collect-check">
                    <input type="checkbox" required />
                    我已确认资料属于所选主机
                  </label>
                  <label className="collect-upload">
                    ⇧<strong>{fileName || "选择JSON文件"}</strong>
                    <small>点击选择本地采集结果</small>
                    <input
                      aria-label="采集JSON文件"
                      type="file"
                      accept=".json,application/json"
                      required
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        setContent("");
                        setFileName("");
                        if (!file) return;
                        if (file.size > 5000000) {
                          setError("资料超过5MB，未截断上传");
                          return;
                        }
                        const revision = ++fileRevision.current;
                        const requested = currentSelection.current;
                        const text = await file.text();
                        if (
                          requested !== currentSelection.current ||
                          revision !== fileRevision.current
                        )
                          return;
                        setContent(text);
                        setFileName(file.name);
                      }}
                    />
                  </label>
                  {content && (
                    <details>
                      <summary>预览原始资料</summary>
                      <pre>{content}</pre>
                    </details>
                  )}
                </>
              ) : (
                <>
                  <div className="collect-fields">
                    <label>
                      资产名称 / 主机名
                      <input
                        name="hostname"
                        required
                        maxLength={255}
                        defaultValue={asset?.name}
                      />
                    </label>
                    <label>
                      来源说明
                      <input
                        name="note"
                        required
                        maxLength={1000}
                        placeholder="例如：客户现场提供"
                      />
                    </label>
                    {(hostType && activeContent !== "software"
                      ? [
                          ["id", "OS发行版ID"],
                          ["version", "OS版本"],
                          ["kernel", "运行内核"],
                          ["architecture", "架构"],
                        ]
                      : []
                    ).map(([key, label]) => (
                      <label key={key}>
                        {label}
                        <input name={key} maxLength={255} />
                      </label>
                    ))}
                  </div>
                  <DeviceFields
                    category={category}
                    softwareOnly={activeContent === "software"}
                  />
                  <details className="collect-options">
                    <summary>更多来源信息</summary>
                    <div className="collect-fields">
                      <label>
                        序列号
                        <input name="serial" maxLength={255} />
                      </label>
                      <label>
                        已知采集时间
                        <input name="collectedAt" type="datetime-local" />
                      </label>
                    </div>
                    <p className="collect-muted">未知字段或时间留空。</p>
                  </details>
                </>
              )}
              <div className="collect-submit">
                <span>
                  ◈{" "}
                  {tab === "connect"
                    ? scope === "basic"
                      ? "仅收集主机资料，不访问 Docker 引擎"
                      : "仅发现目录，不自动扫描镜像"
                    : "保存来源与独立资料版本"}
                </span>
                {tab !== "offline" && (
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      collecting ||
                      !asset ||
                      (tab === "connect" &&
                        (!linuxSupported ||
                          !profileId ||
                          (scope === "container-inventory" &&
                            !directoryAuthorized))) ||
                      (tab === "upload" && !content)
                    }
                  >
                    {busy
                      ? "处理中…"
                      : collecting
                        ? "采集中…"
                        : tab === "connect"
                          ? scope === "basic"
                            ? "开始基础采集 →"
                            : "采集容器目录 →"
                          : scope === "basic"
                            ? "保存基础快照"
                            : "保存容器目录"}
                  </button>
                )}
              </div>
              <div ref={feedback} className="collect-feedback">
                {error && (
                  <div role="alert" className="error">
                    {error}
                  </div>
                )}
                {notice && (
                  <div role="status" className="notice">
                    {notice}
                  </div>
                )}
                {currentJob && (
                  <section
                    aria-label="本次采集任务"
                    className="collect-progress-card"
                    aria-live="polite"
                  >
                    <h3>
                      采集任务：
                      {statuses[currentJob.status] ?? currentJob.status}
                    </h3>
                    <progress
                      aria-label="采集进度"
                      max={100}
                      value={
                        collecting ? undefined : currentJob.snapshotId ? 100 : 0
                      }
                    />
                    {collecting && (
                      <>
                        <p>
                          正在
                          {currentJob.scope === "basic"
                            ? "采集主机基础资料"
                            : "读取 Docker 镜像与容器目录"}
                          ，请稍候…
                        </p>
                      </>
                    )}
                    {currentJob.error && <p>{currentJob.error}</p>}
                    {currentJob.snapshotId && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          void showSnapshot(currentJob.snapshotId!)
                        }
                      >
                        查看本次采集资料
                      </button>
                    )}
                    {!collecting &&
                      !currentJob.snapshotId &&
                      !currentJob.error && (
                        <p>未取得采集资料，请查看任务记录后重试。</p>
                      )}
                  </section>
                )}
              </div>
            </form>
          </div>
        </div>
      </section>
      {asset &&
        (activeContent === "software" || activeContent === "docker") && (
          <ConfigurationMaterials
            key={`${target}:${activeContent}`}
            kind={activeContent === "software" ? "software" : "container"}
            customerId={customerId}
            token={token}
            assetId={target}
            onUnauthorized={onUnauthorized}
            onNavigate={onNavigate}
          />
        )}
      {selected && (
        <section
          ref={inlineResult}
          className="collect-card collect-inline-result"
          aria-label={
            selected.scope === "container-inventory"
              ? "容器采集结果"
              : "采集结果"
          }
        >
          <header className="collect-card-heading">
            <div>
              <span className="collect-kicker">本次采集结果</span>
              <h2>
                {selected.scope === "container-inventory"
                  ? "容器与镜像目录"
                  : "设备资料"}{" "}
                · {selected.identity.hostname}
              </h2>
              <p>
                采集时间：{selected.collectedAt ?? "未知"} ·
                独立快照，尚未进行漏洞评估
              </p>
            </div>
          </header>
          <div className="collect-result-body">
            <div className="collect-review-intro">
              <p className="notice">
                确认后才会更新资产基线，原始采集记录会保留。
              </p>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setSelected(undefined);
                  setNotice(
                    "暂未采纳，资料仍待确认，原基线不变；可在历史中继续处理。",
                  );
                }}
              >
                暂不采纳
              </button>
            </div>
            {selected.extensions.inputFormat === "windows-bat/1" && (
              <WindowsCollectionPreview
                key={selected.id}
                customerId={customerId}
                token={token}
                onUnauthorized={onUnauthorized}
                snapshotId={selected.id}
              />
            )}
            <AssetBaseline
              key={selected.id}
              customerId={customerId}
              token={token}
              onUnauthorized={onUnauthorized}
              assetId={selected.assetId}
              snapshotId={selected.id}
              observationOnly
              scope={
                selected.scope === "container-inventory"
                  ? "container-inventory"
                  : undefined
              }
              onConfirmed={() => setRevision((v) => v + 1)}
            />
            {selected.scope === "container-inventory" && (
              <div className="collect-next-step">
                <p>需要评估镜像组件时，可继续选择镜像生成扫描资料。</p>
                <button
                  className="secondary"
                  onClick={() =>
                    onNavigate?.("containers", selected.assetId, {
                      snapshotId: selected.id,
                      profileId: (
                        selected.extensions.execution as
                          { profileId?: string } | undefined
                      )?.profileId,
                    })
                  }
                >
                  选择镜像生成与扫描
                </button>
              </div>
            )}
            <details className="collect-options">
              <summary>关联软件 / 镜像SBOM版本</summary>
              <VersionLinks
                key={selected.id}
                customerId={customerId}
                token={token}
                onUnauthorized={onUnauthorized}
                snapshot={selected}
              />
            </details>
            <details className="collect-options">
              <summary>来源与完整性</summary>
              <p>接入时间：{new Date(selected.importedAt).toLocaleString()}</p>
              <p className="collect-hash">SHA-256：{selected.contentHash}</p>
              <p>来源说明：{selected.note ?? "自动或脚本采集"}</p>
              <pre>{JSON.stringify(selected.extensions, null, 2)}</pre>
              <button
                type="button"
                className="secondary"
                onClick={() => void readRawSnapshot(selected.id)}
              >
                读取原始资料
              </button>
              {raw && <pre>{raw}</pre>}
            </details>
          </div>
        </section>
      )}
      <details
        className="collect-card collect-history"
        role="region"
        aria-label="采集历史"
      >
        <summary>采集历史</summary>
        <div className="collect-history-toolbar">
          <h2>采集历史</h2>
          <label>
            历史采集类型
            <select
              value={historyScope}
              onChange={(e) => {
                setHistoryScope(e.target.value);
                setOffset(0);
              }}
            >
              <option value="all">全部类型</option>
              <option value="basic">主机基础资料</option>
              <option value="container-inventory">容器运行资料</option>
            </select>
          </label>
        </div>
        <div className="collect-card-heading">
          <div className="collect-history-tabs">
            <button
              className={historyTab === "records" ? "selected" : ""}
              onClick={() => setHistoryTab("records")}
            >
              采集记录 <small>{snapshots?.total ?? 0}</small>
            </button>
            <button
              className={historyTab === "tasks" ? "selected" : ""}
              onClick={() => setHistoryTab("tasks")}
            >
              采集任务 <small>{jobs.length}</small>
            </button>
          </div>
          <button
            className="collect-icon-button"
            title="刷新记录"
            aria-label="刷新记录"
            onClick={() => setRevision((value) => value + 1)}
          >
            ↻
          </button>
        </div>
        {historyTab === "records" ? (
          snapshots?.total ? (
            <>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>主机</th>
                      <th>类型</th>
                      <th>来源 / 执行位置</th>
                      <th>采集时间</th>
                      <th>状态</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {snapshots.items.map((snapshot) => (
                      <tr key={snapshot.id}>
                        <td>
                          <strong>{snapshot.identity.hostname}</strong>
                        </td>
                        <td>
                          {snapshot.scope === "container-inventory"
                            ? "容器运行资料"
                            : "主机基础资料"}
                        </td>
                        <td>
                          {
                            {
                              manual: "人工录入",
                              upload: "脚本上传",
                              pi: "Pi采集",
                              ssh: "主机采集",
                            }[snapshot.entry]
                          }
                          {(
                            snapshot.extensions.execution as
                              { transport?: string } | undefined
                          )?.transport === "local" &&
                            (snapshot.entry === "ssh"
                              ? " · YS 部署主机"
                              : " · 目标机离线执行（操作员确认归属）")}
                        </td>
                        <td>
                          {new Date(snapshot.importedAt).toLocaleString()}
                        </td>
                        <td>
                          <span className="collect-pill">未评估</span>
                        </td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => {
                              setScrollToResult(true);
                              setSelected(snapshot);
                              setRaw(undefined);
                            }}
                          >
                            查看资料 →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pagination">
                <span>共 {snapshots.total} 项</span>
                <div>
                  <button
                    className="secondary"
                    disabled={!offset}
                    onClick={() => setOffset((value) => value - 20)}
                  >
                    上一页
                  </button>
                  <button
                    className="secondary"
                    disabled={offset + 20 >= snapshots.total}
                    onClick={() => setOffset((value) => value + 20)}
                  >
                    下一页
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="collect-empty">
              <span>▤</span>
              <h3>还没有采集记录</h3>
              <p>完成一次采集后，主机资料和来源会保存在这里。</p>
            </div>
          )
        ) : jobs.length ? (
          <div className="collect-task-list">
            {jobs
              .filter(
                (job) => historyScope === "all" || job.scope === historyScope,
              )
              .map((job) => (
                <details key={job.id} data-job-id={job.id}>
                  <summary>
                    <span className={"collect-task-status " + job.status}>
                      {statuses[job.status] ?? job.status}
                    </span>
                    <strong>
                      {job.scope === "basic" ? "基础采集" : "容器目录采集"}
                    </strong>
                    <small>{job.message}</small>
                  </summary>
                  {job.error && <p className="error">{job.error}</p>}
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
                      查看采集资料
                    </button>
                  )}
                </details>
              ))}
          </div>
        ) : (
          <div className="collect-empty">
            <span>◷</span>
            <h3>暂无采集任务</h3>
            <p>运行中的任务会自动更新进度。</p>
          </div>
        )}
      </details>
      {editingConnection && asset && (
        <ConnectionEditor
          customerId={customerId}
          token={token}
          onUnauthorized={onUnauthorized}
          assetId={asset.id}
          assetName={asset.name}
          initialHost={address}
          onClose={() => setEditingConnection(false)}
          onSaved={(id) => {
            setEditingConnection(false);
            setProfiles((items) => [
              ...items,
              { id, assetId: target, label: "新建连接", scopes: ["basic"] },
            ]);
            setProfileId(id);
            setRevision((value) => value + 1);
            setNotice("连接已关联到主机，可以开始基础采集");
          }}
        />
      )}
      {addingAsset && (
        <NewCollectionAsset
          customerId={customerId}
          token={token}
          onUnauthorized={onUnauthorized}
          onClose={() => setAddingAsset(false)}
          onCreated={(id) => {
            setAddingAsset(false);
            setTarget(id);
            setTypeFilter("");
            setAssetOffset(0);
            setRevision((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}
