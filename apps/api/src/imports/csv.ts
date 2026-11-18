import { BadRequestException } from "@nestjs/common";
import type { ImportRow } from "../../../../packages/contracts";
// RFC 4180 quoting, comma delimiter, LF/CRLF. No format inference.
export function parseCsv(content: string): {
  mapping: Record<string, string>;
  rows: ImportRow[];
} {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quoted) {
      if (c === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
      continue;
    }
    if (c === '"') {
      if (field || closed) throw new BadRequestException("CSV 引号位置无效");
      quoted = true;
      continue;
    }
    if (c === "," || c === "\n" || c === "\r") {
      record.push(field);
      field = "";
      closed = false;
      if (c !== ",") {
        if (c === "\r" && content[i + 1] === "\n") i++;
        records.push(record);
        record = [];
      }
      continue;
    }
    if (closed) throw new BadRequestException("CSV 闭合引号后有多余字符");
    field += c;
  }
  if (quoted) throw new BadRequestException("CSV 引号未闭合");
  if (field || record.length || closed) {
    record.push(field);
    records.push(record);
  }
  const headers =
    records
      .shift()
      ?.map((v, i) => (i === 0 ? v.replace(/^\uFEFF/, "") : v).trim()) ?? [];
  if (
    !headers.length ||
    headers.some((v) => !v) ||
    new Set(headers).size !== headers.length
  )
    throw new BadRequestException("CSV 表头为空或重复");
  if (records.length > 1000)
    throw new BadRequestException("CSV 最多 1000 条记录");
  const core = ["source", "sourceRef", "name", "kind", "collectedAt"];
  const mapping = Object.fromEntries(
    headers.map((h) => [h, core.includes(h) ? h : `attributes.${h}`]),
  );
  const identities = new Set<string>();
  const rows = records.map((values, index): ImportRow => {
    const raw = Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
    const issues: string[] = [];
    if (values.length !== headers.length) issues.push("列数与表头不一致");
    for (const field of ["source", "sourceRef", "name", "kind"])
      if (!raw[field]?.trim()) issues.push(`缺失 ${field}`);
    if (raw.kind?.trim() && raw.kind.trim() !== "host")
      issues.push("kind 仅支持 host");
    for (const [key, max] of [
      ["name", 200],
      ["source", 200],
      ["sourceRef", 500],
    ] as const)
      if ((raw[key]?.length ?? 0) > max) issues.push(`${key} 超长`);
    const date = raw.collectedAt?.trim();
    const dayValid =
      !date ||
      (Number(date.slice(8, 10)) >= 1 &&
        Number(date.slice(8, 10)) <=
          new Date(
            Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0),
          ).getUTCDate() &&
        Number(date.slice(5, 7)) >= 1 &&
        Number(date.slice(5, 7)) <= 12);
    if (
      date &&
      (!dayValid ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
          date,
        ) ||
        !Number.isFinite(Date.parse(date)))
    )
      issues.push("collectedAt 需为带时区的 ISO 日期");
    const mapped = {
      name: raw.name?.trim() ?? "",
      kind: raw.kind?.trim() ?? "",
      source: raw.source?.trim() ?? "",
      sourceRef: raw.sourceRef?.trim() ?? "",
      collectedAt:
        date && Number.isFinite(Date.parse(date))
          ? new Date(date).toISOString()
          : null,
      attributes: Object.fromEntries(
        headers.filter((h) => !core.includes(h)).map((h) => [h, raw[h]]),
      ),
    };
    const key = JSON.stringify([mapped.source, mapped.kind, mapped.sourceRef]);
    const duplicate = identities.has(key);
    identities.add(key);
    if (duplicate) issues.push("同批来源对象标识重复或歧义");
    return {
      row: index + 2,
      status: issues.length ? (duplicate ? "duplicate" : "invalid") : "ready",
      issues,
      mapped,
    };
  });
  if (!rows.length) throw new BadRequestException("CSV 没有数据记录");
  return { mapping, rows };
}
