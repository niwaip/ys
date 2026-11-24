export const escapeHtml = (value: unknown) =>
  String(value ?? "未知").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function table(headers: string[], rows: unknown[][]): string {
  return `<table><thead><tr>${headers.map((value) => `<th>${escapeHtml(value)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
