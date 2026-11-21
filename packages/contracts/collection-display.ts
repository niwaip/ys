/** Stable capacity/identity projection; raw collection evidence remains untouched. */
export function hardwareSummary(value: unknown) {
  const v = (value ?? {}) as Record<string, unknown>;
  const raw = (key: string) => {
    const item = v[key] as { data?: unknown } | undefined;
    return typeof item?.data === "string" ? item.data : "";
  };
  const cpu = raw("cpu"),
    memory = raw("memory"),
    disks = raw("disks");
  const cores = cpu.match(/^processor\s*:\s*\d+/gm)?.length ?? null;
  const memoryKB = /^MemTotal:\s*(\d+)\s*kB/m.exec(memory)?.[1];
  const seen = new Set<string>();
  const volumes: { mount: string; bytes: number }[] = [];
  for (const line of disks.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (
      parts.length < 6 ||
      !parts[0].startsWith("/dev/") ||
      parts[0].startsWith("/dev/loop") ||
      seen.has(parts[0]) ||
      !/^\d+$/.test(parts[1])
    )
      continue;
    seen.add(parts[0]);
    volumes.push({
      mount: parts.slice(5).join(" "),
      bytes: Number(parts[1]) * 1024,
    });
  }
  return {
    cpu: { cores },
    memory: { bytes: memoryKB ? Number(memoryKB) * 1024 : null },
    disks: {
      bytes: volumes.length ? volumes.reduce((n, v) => n + v.bytes, 0) : null,
      volumes: volumes.length ? volumes : null,
    },
  };
}
export function networkSummary(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => ({
    ifname: String(v.ifname ?? "未知接口"),
    status: v.operstate == null ? null : String(v.operstate),
    addresses: Array.isArray(v.addr_info)
      ? v.addr_info
          .filter(
            (a: { scope?: string; family?: string }) =>
              a.family === "inet" ||
              (a.family === "inet6" && a.scope === "global"),
          )
          .map(
            (a: { local?: string; prefixlen?: number }) =>
              `${a.local ?? ""}${a.prefixlen !== undefined ? "/" + a.prefixlen : ""}`,
          )
      : null,
  }));
}
