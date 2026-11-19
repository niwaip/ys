import { useEffect, useState } from "react";
import { api } from "../../api";
import type { AssetVersionLink } from "../../../../../packages/contracts/collections";
import type { SoftwareComponent } from "../../../../../packages/contracts/software";

/** Host associations remain explicit; a customer's SBOM is not automatically deployed here. */
export function AssetSoftware({
  customerId,
  assetId,
  token,
  kind,
  onError,
}: {
  customerId: string;
  assetId: string;
  token: string;
  kind: "software" | "container";
  onError: (error: unknown) => void;
}) {
  const [links, setLinks] = useState<AssetVersionLink[]>();
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<{
    name: string;
    version: string | null;
    components: SoftwareComponent[];
  }>();
  const [componentOffset, setComponentOffset] = useState(0);
  const [query, setQuery] = useState("");
  const base = `/customers/${customerId}`;
  useEffect(() => {
    const c = new AbortController();
    setLinks(undefined);
    api<{ items: AssetVersionLink[] }>(
      `${base}/collections/links?assetId=${assetId}&kind=${kind}&offset=${offset}`,
      token,
      {},
      c.signal,
    )
      .then((v) => {
        if (!c.signal.aborted) setLinks(v.items);
      })
      .catch((e) => {
        if (!c.signal.aborted) onError(e);
      });
    return () => c.abort();
  }, [base, assetId, token, offset, kind]);
  useEffect(() => {
    setDetail(undefined);
    setComponentOffset(0);
    setQuery("");
    const link = links?.find((v) => v.id === selected);
    if (!link) return;
    const c = new AbortController();
    const path = `${base}/${kind === "software" ? "software" : "containers"}/${link.objectId}`;
    Promise.all([
      api<{ name: string }>(path, token, {}, c.signal),
      api<{ version: string | null; components: SoftwareComponent[] }>(
        `${path}/versions/${link.versionId}`,
        token,
        {},
        c.signal,
      ),
    ])
      .then(([object, version]) => {
        if (!c.signal.aborted) setDetail({ ...version, name: object.name });
      })
      .catch((e) => {
        if (!c.signal.aborted) onError(e);
      });
    return () => c.abort();
  }, [selected, links, base, token, kind]);
  const items = links?.filter((v) => v.kind === kind) ?? [];
  const components =
    detail?.components.filter((c) =>
      `${c.name} ${c.version ?? ""} ${c.purl ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) ?? [];
  return (
    <section className="baseline-layer">
      <header>
        <h3>{kind === "software" ? "软件 / 项目" : "镜像 SBOM 与组件"}</h3>
      </header>
      <div className="baseline-layer-content">
        {!links ? (
          <p role="status">正在读取关联资料…</p>
        ) : !items.length ? (
          <p>
            {kind === "software"
              ? "尚未关联软件 / 项目 SBOM"
              : "尚未关联镜像 SBOM"}
          </p>
        ) : (
          <div className="baseline-list-controls">
            {items.map((link) => (
              <button
                key={link.id}
                className={selected === link.id ? "primary" : "secondary"}
                onClick={() => setSelected(link.id)}
              >
                {link.basis} ·{" "}
                {new Date(link.createdAt).toLocaleString("zh-CN")}
              </button>
            ))}
          </div>
        )}
        <p className="collect-muted">
          {kind === "software"
            ? "在软件页面上传 SBOM，并在采集资料详情中关联到本主机；此处展示固定版本的组件。"
            : "以下组件来自显式关联的镜像 SBOM，不代表已扫描容器可写层或挂载卷。"}
        </p>
        {(offset > 0 || (links?.length ?? 0) >= 100) && (
          <div className="pagination">
            <button
              disabled={!offset}
              onClick={() => {
                setSelected(undefined);
                setOffset(Math.max(0, offset - 100));
              }}
            >
              上一批关联
            </button>
            <button
              disabled={(links?.length ?? 0) < 100}
              onClick={() => {
                setSelected(undefined);
                setOffset(offset + 100);
              }}
            >
              下一批关联
            </button>
          </div>
        )}
        {detail && (
          <>
            <h4>
              {detail.name} · {detail.version ?? "版本未声明"}
            </h4>
            <input
              aria-label="搜索SBOM组件"
              placeholder="搜索组件名称、版本或 PURL"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setComponentOffset(0);
              }}
            />
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>组件</th>
                    <th>版本</th>
                    <th>生态</th>
                    <th>PURL</th>
                  </tr>
                </thead>
                <tbody>
                  {components
                    .slice(componentOffset, componentOffset + 50)
                    .map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td>{c.version ?? "未知"}</td>
                        <td>{c.ecosystem ?? "未知"}</td>
                        <td>{c.purl ?? "未提供"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>共 {components.length} 个组件</span>
              <button
                disabled={!componentOffset}
                onClick={() => setComponentOffset((v) => Math.max(0, v - 50))}
              >
                上一批组件
              </button>
              <button
                disabled={componentOffset + 50 >= components.length}
                onClick={() => setComponentOffset((v) => v + 50)}
              >
                下一批组件
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
