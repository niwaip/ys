import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api";
import type { FeatureProps } from "../../features";
type Credential = { id: string; name: string };
export function ConnectionEditor({
  customerId,
  token,
  assetId,
  assetName,
  initialHost,
  onClose,
  onSaved,
}: FeatureProps & {
  assetId: string;
  assetName: string;
  initialHost: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [credentials, setCredentials] = useState<Credential[]>([]),
    [credentialId, setCredentialId] = useState(""),
    [creating, setCreating] = useState(false),
    [credentialName, setCredentialName] = useState(""),
    [privateKey, setPrivateKey] = useState(""),
    [host, setHost] = useState(initialHost),
    [port, setPort] = useState(22),
    [hostKey, setHostKey] = useState(""),
    [fingerprint, setFingerprint] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const base = `/customers/${customerId}/collections`;
  useEffect(() => {
    const controller = new AbortController();
    api<{ items: Credential[] }>(
      `${base}/credentials`,
      token,
      {},
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setCredentials(result.items);
          setCredentialId(result.items[0]?.id ?? "");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [base, token]);
  async function saveCredential() {
    setBusy(true);
    setError("");
    try {
      const value = await api<Credential>(`${base}/credentials`, token, {
        method: "POST",
        body: JSON.stringify({ name: credentialName, privateKey }),
      });
      setCredentials((old) => [value, ...old]);
      setCredentialId(value.id);
      setPrivateKey("");
      setCredentialName("");
      setCreating(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function probe() {
    setBusy(true);
    setError("");
    setConfirmed(false);
    try {
      const result = await api<{ hostKey: string; fingerprint: string }>(
        `${base}/connections/host-key`,
        token,
        { method: "POST", body: JSON.stringify({ assetId, host, port }) },
      );
      setHostKey(result.hostKey);
      setFingerprint(result.fingerprint);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: string }>(`${base}/connections`, token, {
        method: "POST",
        body: JSON.stringify({
          assetId,
          name: data.get("name"),
          host,
          port,
          username: data.get("username"),
          credentialId,
          hostKey,
          trustConfirmed: confirmed,
          allowDocker: data.get("allowDocker") === "on",
        }),
      });
      onSaved(result.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="collect-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="collect-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-title"
      >
        <header>
          <div>
            <span className="collect-kicker">主机访问</span>
            <h2 id="connection-title">新建主机连接</h2>
            <p>
              关联至 <strong>{assetName}</strong>
            </p>
          </div>
          <button
            type="button"
            className="collect-icon-button"
            aria-label="关闭连接窗口"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <form onSubmit={submit}>
          <div className="collect-fields">
            <label className="collect-wide">
              连接名称
              <input
                name="name"
                required
                maxLength={100}
                defaultValue={`${assetName} · SSH`}
                placeholder="例如：生产只读连接"
              />
            </label>
            <label>
              主机地址
              <input
                value={host}
                disabled={busy}
                onChange={(e) => {
                  setHost(e.target.value);
                  setHostKey("");
                  setConfirmed(false);
                  setFingerprint("");
                }}
                required
                placeholder="IP 或域名"
              />
            </label>
            <label>
              SSH端口
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                disabled={busy}
                onChange={(e) => {
                  setPort(Number(e.target.value));
                  setHostKey("");
                  setConfirmed(false);
                  setFingerprint("");
                }}
                required
              />
            </label>
            <label className="collect-wide">
              登录账号
              <input
                name="username"
                required
                placeholder="例如：collector"
                autoComplete="off"
              />
            </label>
          </div>
          <div className="collect-label-row">
            <span>
              登录凭证{" "}
              <span
                className="collect-tip"
                tabIndex={0}
                title="凭证独立保存，可关联同一客户的多台主机。私钥加密保存，任务仅短暂解密使用，页面不会回显。"
              >
                ⓘ
              </span>
            </span>
            <button
              className="text-button"
              type="button"
              onClick={() => setCreating((value) => !value)}
            >
              ＋ 新建凭证
            </button>
          </div>
          <select
            aria-label="登录凭证"
            value={credentialId}
            onChange={(e) => setCredentialId(e.target.value)}
            required
          >
            <option value="">选择已保存的SSH密钥</option>
            {credentials.map((value) => (
              <option key={value.id} value={value.id}>
                {value.name}
              </option>
            ))}
          </select>
          {creating && (
            <div className="collect-inset">
              <h3>保存一项SSH凭证</h3>
              <label>
                凭证名称
                <input
                  value={credentialName}
                  onChange={(e) => setCredentialName(e.target.value)}
                  placeholder="例如：运维只读密钥"
                  maxLength={100}
                />
              </label>
              <label>
                SSH私钥
                <textarea
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  rows={5}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              </label>
              <p className="collect-muted">
                使用无口令SSH私钥。保存后可复用，私钥不会再次显示。
              </p>
              <button
                type="button"
                className="secondary"
                disabled={busy || !credentialName || !privateKey}
                onClick={() => void saveCredential()}
              >
                保存凭证
              </button>
            </div>
          )}
          <div className="collect-label-row">
            <span>
              主机身份{" "}
              <span
                className="collect-tip"
                tabIndex={0}
                title="读取公钥后，请通过可信渠道核对指纹。保存后严格校验主机身份，身份变化时不会自动接受。"
              >
                ⓘ
              </span>
            </span>
            <button
              className="text-button"
              type="button"
              disabled={busy || !host || !port}
              onClick={() => void probe()}
            >
              读取主机指纹
            </button>
          </div>
          {fingerprint ? (
            <div className="collect-fingerprint">
              <code>{fingerprint}</code>
              <label className="collect-check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  required
                />
                我已核对该主机指纹
              </label>
            </div>
          ) : (
            <p className="collect-muted">填写地址后读取并核对主机指纹。</p>
          )}
          <details className="collect-options">
            <summary>更多访问选项</summary>
            <label className="collect-check">
              <input type="checkbox" name="allowDocker" />
              允许读取Docker引擎与目录{" "}
              <span
                className="collect-tip"
                tabIndex={0}
                title="需要账号本身具备Docker权限；不会自动提权、加入用户组或读取容器环境变量。容器目录仍单独发起。"
              >
                ⓘ
              </span>
            </label>
          </details>
          <footer>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="primary"
              disabled={busy || !credentialId || !confirmed || !hostKey}
            >
              {busy ? "保存中…" : "保存连接"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
