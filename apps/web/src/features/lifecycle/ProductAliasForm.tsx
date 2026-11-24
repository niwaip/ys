import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import type { SupportReference } from "../../../../../packages/contracts/lifecycle-workspace";
export function ProductAliasForm(
  props: FeatureProps & { reference: SupportReference; onSaved: () => void },
) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api(
        `/customers/${props.customerId}/lifecycle/aliases`,
        props.token,
        {
          method: "POST",
          body: JSON.stringify({
            category: props.reference.kind,
            alias: f.get("alias"),
            product: f.get("product"),
            basis: f.get("basis"),
          }),
        },
      );
      props.onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) props.onUnauthorized();
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>
        配置产品别名 · {props.reference.rawProduct || props.reference.product}
      </summary>
      <p>
        明确名称对应关系后，同一产品及版本可在本客户资产间复用；版本不从名称推测。多个目标保持待核对。
      </p>
      <form onSubmit={save}>
        <fieldset disabled={busy}>
          <label>
            原始产品名
            <input
              name="alias"
              required
              maxLength={500}
              defaultValue={
                props.reference.rawProduct || props.reference.product
              }
            />
          </label>
          <label>
            厂商标准产品名
            <input name="product" required maxLength={500} />
          </label>
          <label>
            映射依据
            <input name="basis" required maxLength={1000} />
          </label>
          <button>保存产品别名</button>
        </fieldset>
      </form>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
