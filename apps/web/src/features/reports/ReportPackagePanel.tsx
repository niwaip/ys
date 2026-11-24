import { useEffect, useRef, useState } from "react";
import type { Report } from "../../../../../packages/contracts/reports";
import type { ReportPackage } from "../../../../../packages/contracts/report-packages";
import type { FeatureProps } from "../../features";
import { api, ApiError } from "../../api";
export function ReportPackagePanel({
  report,
  customerId,
  token,
  onUnauthorized,
}: FeatureProps & { report: Report }) {
  const [packages, setPackages] = useState<ReportPackage[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [pdfMode, setPdfMode] = useState<"summary" | "full">("summary"),
    [perHost, setPerHost] = useState(false),
    [evidence, setEvidence] = useState(false);
  const controller = useRef(new AbortController());
  const base = `/customers/${customerId}/reports/${report.id}/revisions/${report.revision.id}/packages`;
  const call = <T,>(path: string, options: RequestInit = {}) =>
    api<T>(path, token, options, controller.current.signal);
  function fail(e: unknown) {
    if (controller.current.signal.aborted) return;
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  async function refresh() {
    setPackages((await call<{ items: ReportPackage[] }>(base)).items);
  }
  useEffect(() => {
    controller.current = new AbortController();
    setPackages([]);
    setError("");
    refresh().catch(fail);
    return () => controller.current.abort();
  }, [base, token]);
  const active = packages.some((p) => p.status === "generating");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => refresh().catch(fail), 700);
    return () => clearInterval(timer);
  }, [active, base]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function create(audience: "draft" | "official") {
    await call(base, {
      method: "POST",
      body: JSON.stringify({
        audience,
        pdfMode,
        perHostIds: perHost
          ? (report.revision.facts.center?.hosts.map((h) => h.assetId) ?? [])
          : [],
        evidenceAssessmentIds: evidence
          ? report.revision.facts.assessmentSnapshots.map((a) => a.id)
          : [],
      }),
    });
    await refresh();
  }
  async function download(path: string, name: string) {
    const response = await fetch(`/api${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.current.signal,
    });
    if (!response.ok)
      throw new ApiError("文件尚未可用或校验失败", response.status);
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section aria-label="报告文件与交付包">
      <h3>报告文件与交付包</h3>
      <p>
        默认包含 PDF、离线 HTML、完整 XLSX
        和校验清单。包完整性与扫描覆盖分别呈现；可用文件均来自当前固定修订。
      </p>
      <label>
        PDF 明细模式
        <select
          aria-label="PDF 明细模式"
          value={pdfMode}
          onChange={(e) => setPdfMode(e.target.value as "summary" | "full")}
        >
          <option value="summary">摘要（每评估按严重程度前 20 条）</option>
          <option value="full">完整漏洞明细</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={perHost}
          onChange={(e) => setPerHost(e.target.checked)}
          disabled={!report.revision.facts.center}
        />
        逐台服务器 PDF 分报告
      </label>
      <label>
        <input
          type="checkbox"
          checked={evidence}
          onChange={(e) => setEvidence(e.target.checked)}
        />
        原始扫描证据（缺失或校验失败会单独披露）
      </label>
      <button disabled={busy} onClick={() => run(() => create("draft"))}>
        生成草稿报告包
      </button>
      <button
        disabled={busy || report.revision.status !== "delivered"}
        onClick={() => run(() => create("official"))}
      >
        生成正式报告包
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {packages.map((bundle) => (
        <article key={bundle.id}>
          <h4>
            {bundle.input.audience === "draft"
              ? "草稿 · 未复核"
              : "正式交付 · 已复核"}{" "}
            ·{" "}
            {bundle.status === "complete"
              ? "报告包完整"
              : bundle.status === "generating"
                ? "文件生成中"
                : "报告包不完整"}
          </h4>
          <p>
            修订 {report.revision.number} · {bundle.createdAt} ·{" "}
            {bundle.createdBy}
          </p>
          <button
            disabled={busy || bundle.status !== "complete"}
            onClick={() =>
              run(() =>
                download(
                  `${base}/${bundle.id}/download`,
                  `ys-${bundle.input.audience}-complete.zip`,
                ),
              )
            }
          >
            下载完整 ZIP 报告包
          </button>
          {bundle.status === "partial" && (
            <button
              disabled={busy}
              onClick={() =>
                run(() =>
                  download(
                    `${base}/${bundle.id}/download?partial=true`,
                    "ys-INCOMPLETE.zip",
                  ),
                )
              }
            >
              下载可用部分（不完整）
            </button>
          )}
          {bundle.files.some((f) => f.status === "failed") && (
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await call(`${base}/${bundle.id}/retry`, {
                    method: "POST",
                    body: JSON.stringify({
                      fileIds: bundle.files
                        .filter((f) => f.status === "failed")
                        .map((f) => f.id),
                    }),
                  });
                  await refresh();
                })
              }
            >
              仅重试失败文件
            </button>
          )}
          <ul>
            {bundle.files.map((file) => (
              <li key={file.id}>
                {file.name} · {file.status}{" "}
                {file.error && <span role="status">{file.error}</span>}{" "}
                {file.status === "failed" && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await call(`${base}/${bundle.id}/retry`, {
                          method: "POST",
                          body: JSON.stringify({ fileIds: [file.id] }),
                        });
                        await refresh();
                      })
                    }
                  >
                    重试此文件 · {file.format.toUpperCase()}
                  </button>
                )}
                {file.status === "ready" && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        download(
                          `${base}/${bundle.id}/files/${file.id}`,
                          file.name.replaceAll("/", "-"),
                        ),
                      )
                    }
                  >
                    下载 {file.format.toUpperCase()}
                    {file.hostId ? ` · ${file.hostId.slice(0, 8)}` : ""}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}
