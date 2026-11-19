import { useEffect, useState, type FormEvent } from "react";
import type {
  AssetVersionLink,
  CollectionSnapshot,
} from "../../../../../packages/contracts/collections";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import { requestId } from "../../request-id";
export function VersionLinks({
  customerId,
  token,
  onUnauthorized,
  snapshot,
}: FeatureProps & { snapshot: CollectionSnapshot }) {
  const [links, setLinks] = useState<AssetVersionLink[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const base = `/customers/${customerId}`;
  function fail(e: unknown) {
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  useEffect(() => {
    const controller = new AbortController();
    api<{ items: AssetVersionLink[] }>(
      `${base}/collections/links`,
      token,
      {},
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted)
          setLinks(
            result.items.filter((link) => link.snapshot.id === snapshot.id),
          );
      })
      .catch((e) => {
        if (!controller.signal.aborted) fail(e);
      });
    return () => controller.abort();
  }, [base, token, snapshot.id, revision, onUnauthorized]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api(`${base}/collections/links`, token, {
        method: "POST",
        body: JSON.stringify({
          assetId: snapshot.assetId,
          snapshotId: snapshot.id,
          kind: values.get("kind"),
          objectId: values.get("objectId"),
          versionId: values.get("versionId"),
          basis: values.get("basis"),
          imageId: String(values.get("imageId") || "") || undefined,
        }),
      });
      setRevision((x) => x + 1);
      setNotice("已保存操作员声明的关联；未自动发起评估");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function assess(link: AssetVersionLink) {
    setBusy(true);
    setError("");
    try {
      const job = await api<{ id: string; status: string }>(
        `${base}/assessments`,
        token,
        {
          method: "POST",
          body: JSON.stringify({
            [link.kind === "software" ? "softwareId" : "containerId"]:
              link.objectId,
            versionId: link.versionId,
            linkId: link.id,
            idempotencyKey: requestId(),
          }),
        },
      );
      setNotice(
        `独立评估已提交：${job.id}；请在软件/镜像评估页面查看结果，报告将保留本次固定关联。`,
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3>关联软件 / 镜像SBOM版本</h3>
      <p>
        主机原始Linux包清单暂不支持直接评估，不表示零漏洞。先在软件或容器页面上传SBOM，再填写明确对象和版本编号。关联属于操作员声明，不证明运行适用性。
      </p>
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
      <details>
        <summary>添加版本关联</summary>
        <form onSubmit={create}>
          <label>
            对象类型
            <select name="kind">
              <option value="software">软件应用</option>
              <option value="container">容器镜像</option>
            </select>
          </label>
          <label>
            对象编号
            <input name="objectId" required />
          </label>
          <label>
            SBOM输入版本编号
            <input name="versionId" required />
          </label>
          <label>
            镜像ImageID（仅镜像，digest已在SBOM提供时可留空）
            <input name="imageId" placeholder="sha256:…" />
          </label>
          <label>
            关联依据
            <textarea name="basis" required maxLength={2000} />
          </label>
          <button className="secondary" disabled={busy}>
            保存明确关联
          </button>
        </form>
      </details>
      {links.map((link) => (
        <div key={link.id}>
          <p>
            {link.kind} · {link.objectId} / {link.versionId}；依据：{link.basis}
          </p>
          {link.imageIdentity && <p>{link.imageIdentity.coverage}</p>}
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void assess(link)}
          >
            以此固定SBOM版本发起评估
          </button>
        </div>
      ))}
    </section>
  );
}
