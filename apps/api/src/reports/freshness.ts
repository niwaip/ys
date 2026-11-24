export function freshness(
  date: string | null,
  at: string,
  days: number,
): "fresh" | "stale" | "unknown" {
  if (!date) return "unknown";
  const age = Date.parse(at) - Date.parse(date);
  return !Number.isFinite(age) || age < 0
    ? "unknown"
    : age > days * 86400000
      ? "stale"
      : "fresh";
}
