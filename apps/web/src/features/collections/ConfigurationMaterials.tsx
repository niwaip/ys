import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import type {
  AssetVersionLink,
  CollectionSnapshot,
} from "../../../../../packages/contracts/collections";
import { SoftwarePage } from "../software/SoftwarePage";
import { ContainersPage } from "../containers/ContainersPage";
export function ConfigurationMaterials({
  kind,
  ...props
}: FeatureProps & { kind: "software" | "container" }) {
  const { customerId, token, assetId, onUnauthorized } = props;
  const base = `/customers/${customerId}`;
  const [links, setLinks] = useState<AssetVersionLink[]>([]),
    [snapshots, setSnapshots] = useState<CollectionSnapshot[]>([]),
    [objects, setObjects] = useState<{ id: string; name: string }[]>([]),
    [object, setObject] = useState(""),
    [versions, setVersions] = useState<
      { id: string; version: string | null }[]
    >([]),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  function fail(e: unknown) {
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  useEffect(() => {
    const c = new AbortController();
    Promise.all([
      api<{ items: AssetVersionLink[] }>(
        `${base}/collections/links?assetId=${assetId}&kind=${kind}`,
        token,
        {},
        c.signal,
      ),
      api<{ items: CollectionSnapshot[] }>(
        `${base}/collections/snapshots?assetId=${assetId}&limit=100`,
        token,
        {},
        c.signal,
      ),
      api<{ items: { id: string; name: string }[] }>(
        `${base}/${kind === "software" ? "software" : "containers"}`,
        token,
        {},
        c.signal,
      ),
    ])
      .then(([l, s, o]) => {
        if (!c.signal.aborted) {
          setLinks(l.items);
          setSnapshots(s.items.filter((i) => i.assetId === assetId));
          setObjects(o.items);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) fail(e);
      });
    return () => c.abort();
  }, [base, token, assetId, kind, revision]);
  useEffect(() => {
    setVersions([]);
    if (!object) return;
    const c = new AbortController();
    api<{ versions: { id: string; version: string | null }[] }>(
      `${base}/${kind === "software" ? "software" : "containers"}/${object}`,
      token,
      {},
      c.signal,
    )
      .then((v) => {
        if (!c.signal.aborted) setVersions(v.versions);
      })
      .catch((e) => {
        if (!c.signal.aborted) fail(e);
      });
    return () => c.abort();
  }, [object, kind, base, token]);
  return (
    <section
      className="configuration-materials"
      aria-label={kind === "software" ? "主机软件组件资料" : "主机镜像组件资料"}
    >
      <h3>已关联当前主机的固定版本</h3>
      <p>
        共享对象保留独立版本；关联属于带依据的声明，不证明运行适用性。这里只列最近100条关联。
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {links.length ? (
        links.map((l) => (
          <article key={l.id}>
            <strong>
              {objects.find((o) => o.id === l.objectId)?.name ?? l.objectId}
            </strong>
            <p>
              版本：{l.versionId} · 来源：{l.snapshot.entry} · {l.basis}
            </p>
          </article>
        ))
      ) : (
        <p>尚无明确关联资料</p>
      )}
      <details
        onToggle={(e) => {
          if (e.currentTarget.open) setRevision((v) => v + 1);
        }}
      >
        <summary>关联已有资料到当前主机</summary>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            try {
              await api(`${base}/collections/links`, token, {
                method: "POST",
                body: JSON.stringify({
                  assetId,
                  snapshotId: data.get("snapshot"),
                  kind,
                  objectId: object,
                  versionId: data.get("version"),
                  basis: data.get("basis"),
                  ...(kind === "container" && data.get("imageId")
                    ? { imageId: data.get("imageId") }
                    : {}),
                }),
              });
              setRevision((v) => v + 1);
            } catch (e) {
              fail(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            主机资料版本
            <select name="snapshot" aria-label="主机资料版本" required>
              <option value="">选择采集快照</option>
              {snapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {new Date(s.importedAt).toLocaleString()} · {s.fileName}
                </option>
              ))}
            </select>
          </label>
          <label>
            资料对象
            <select
              value={object}
              aria-label="资料对象"
              onChange={(e) => setObject(e.target.value)}
              required
            >
              <option value="">选择对象</option>
              {objects.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            组件资料版本
            <select
              name="version"
              aria-label="组件资料版本"
              key={object}
              required
            >
              <option value="">选择固定版本</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.version ?? "发布版本未知"} · {v.id}
                </option>
              ))}
            </select>
          </label>
          {kind === "container" && (
            <label>
              镜像ImageID（SBOM有digest可留空）
              <input name="imageId" placeholder="sha256:…" />
            </label>
          )}
          <label>
            关联依据
            <textarea name="basis" required maxLength={2000} />
          </label>
          <button disabled={busy} className="secondary">
            确认关联当前主机
          </button>
        </form>
      </details>
      <details>
        <summary>待关联及共享组件资料库</summary>
        <p>
          下方资料属于当前客户，未明确关联的资料不会计入本主机配置。创建或上传后，请在上方明确关联。
        </p>
        {kind === "software" ? (
          <SoftwarePage {...props} />
        ) : (
          <ContainersPage {...props} />
        )}
      </details>
    </section>
  );
}
