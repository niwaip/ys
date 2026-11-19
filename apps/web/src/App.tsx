import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Customer } from "../../../packages/contracts";
import { api } from "./api";
import { features, featureGroups } from "./features";
export function App() {
  const [token, setToken] = useState(
    () => sessionStorage.getItem("ys-token") ?? "",
  );
  const [session, setSession] = useState<{
    items: Customer[];
    operator: { name: string };
  }>();
  const [customerId, setCustomerId] = useState(
    () => sessionStorage.getItem("ys-customer") ?? "",
  );
  const [featureId, setFeatureId] = useState(
    () => location.hash.slice(1).split("?")[0] || features[0].id,
  );
  const [assetId, setAssetId] = useState<string | undefined>(
    () =>
      new URLSearchParams(location.hash.split("?")[1]).get("asset") ??
      undefined,
  );
  function navigate(id: string, asset?: string) {
    setFeatureId(id);
    setAssetId(asset);
    location.hash = id + (asset ? "?asset=" + encodeURIComponent(asset) : "");
  }
  useEffect(() => {
    const change = () => {
      setFeatureId(location.hash.slice(1).split("?")[0] || features[0].id);
      setAssetId(
        new URLSearchParams(location.hash.split("?")[1]).get("asset") ??
          undefined,
      );
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const logout = useCallback(() => {
    sessionStorage.removeItem("ys-token");
    setToken("");
    setSession(undefined);
    setError("");
  }, []);
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setChecking(true);
    api<{ items: Customer[]; operator: { name: string } }>(
      "/customers",
      token,
      {},
      controller.signal,
    )
      .then((result) => {
        setSession(result);
        setError("");
        sessionStorage.setItem("ys-token", token);
        setCustomerId((previous) =>
          result.items.some((c) => c.id === previous)
            ? previous
            : (result.items[0]?.id ?? ""),
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(e.message);
          setSession(undefined);
          sessionStorage.removeItem("ys-token");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [token, attempt]);
  function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setToken(String(new FormData(e.currentTarget).get("token") ?? "").trim());
    setAttempt((x) => x + 1);
  }
  if (!session)
    return (
      <div className="login">
        <div className="login-story">
          <div className="brand">
            <b>Y</b> YS <span>ASSET INTELLIGENCE</span>
          </div>
          <div>
            <div className="eyebrow">从清晰的资产开始</div>
            <h1>
              看清资产。
              <br />
              理解风险。
            </h1>
            <p>
              在一个可信赖的工作空间里，
              <br />
              连接资产、证据与每一次判断。
            </p>
            <div className="story-line" />
          </div>
          <small>YS / 客户资产风险工作台</small>
        </div>
        <main className="login-form">
          <div className="eyebrow">OPERATOR WORKSPACE</div>
          <h2>欢迎回到工作台</h2>
          <p className="subtle">使用管理员配置的操作员凭据访问授权客户。</p>
          <form onSubmit={login}>
            <label>
              操作员访问令牌
              <input
                type="password"
                name="token"
                required
                autoComplete="current-password"
                placeholder="输入您的访问令牌"
              />
            </label>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button className="primary" disabled={checking}>
              {checking ? "正在验证…" : "进入工作台"}
            </button>
          </form>
          <p className="hint">凭据仅保存在当前浏览器会话，退出后清除。</p>
        </main>
      </div>
    );
  const feature = features.find((f) => f.id === featureId) ?? features[0];
  const Page = feature.component;
  const customer = session.items.find((c) => c.id === customerId);
  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="brand">
          <b>Y</b> YS <span>工作台</span>
        </div>
        <div className="workspace-label">客户空间</div>
        <label className="customer-picker">
          当前客户
          <select
            value={customerId}
            onChange={(e) => {
              setCustomerId(e.target.value);
              navigate(featureId);
              sessionStorage.setItem("ys-customer", e.target.value);
            }}
          >
            {session.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="nav-label">管理工作区</div>
        <nav>
          {featureGroups.map((group) => (
            <section className="nav-group" key={group} aria-label={group}>
              <div className="nav-label">{group}</div>
              {features
                .filter((f) => !f.hidden && f.group === group)
                .map((f) => (
                  <button
                    key={f.id}
                    className={feature.id === f.id ? "active" : ""}
                    onClick={() => navigate(f.id)}
                  >
                    <span>{f.icon}</span>
                    {f.label}
                    <span className="nav-arrow">↗</span>
                  </button>
                ))}
            </section>
          ))}
        </nav>
        <div className="sidebar-note">
          <span>◈</span>
          <strong>让每一个结论有据可依</strong>
          <p>
            资产资料是风险评估的起点。
            <br />
            未知状态将明确保留。
          </p>
        </div>
        <div className="operator">
          <div className="avatar">{session.operator.name.slice(0, 1)}</div>
          <div>
            <strong>{session.operator.name}</strong>
            <small>内部操作人员</small>
          </div>
          <button onClick={logout}>退出</button>
        </div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <div>
            工作空间 <span>/</span>{" "}
            <strong>{customer?.name ?? "无授权客户"}</strong>
          </div>
          <span className="scope-badge">● 客户独立视图</span>
        </header>
        <main
          className="page"
          key={`${customerId}:${feature.id}:${assetId ?? ""}`}
        >
          {customer ? (
            <Page
              customerId={customer.id}
              token={token}
              onUnauthorized={logout}
              onNavigate={navigate}
              assetId={assetId}
            />
          ) : (
            <div className="empty">
              当前账号没有可访问的客户，请联系管理员。
            </div>
          )}
        </main>
        <footer>
          YS · 资产风险工作台 <span>以事实为依据，以客户为边界</span>
        </footer>
      </div>
    </div>
  );
}
