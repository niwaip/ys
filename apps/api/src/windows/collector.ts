import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
const text = z.preprocess(
  (value) => (typeof value === "string" && !value.trim() ? null : value),
  z.string().trim().min(1).max(500).nullable().optional(),
);
const rawSchema = z
  .object({
    TargetAssetId: z.uuid().optional(),
    Hostname: z.string().trim().min(1).max(200),
    SerialNumber: text,
    CollectorVersion: text,
    CollectedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    OS: text,
    OSVersion: text,
    OSBuild: text,
    FullBuild: text,
    Architecture: text,
    UBR: z.number().int().nonnegative().nullable().optional(),
    InstalledSoftware: z
      .array(
        z.object({ Name: text, Version: text, Publisher: text }).passthrough(),
      )
      .max(10000)
      .optional(),
    InstalledKBs: z
      .array(z.string().regex(/^KB\d+$/i))
      .max(10000)
      .optional(),
    KBDetails: z
      .array(z.object({ KB: z.string().regex(/^KB\d+$/i) }).passthrough())
      .max(10000)
      .optional(),
    CollectionStatus: z.record(z.string(), z.json()).optional(),
    KBInventoryComplete: z.boolean().nullable().optional(),
    SoftwareInventoryComplete: z.boolean().nullable().optional(),
    RebootPending: z.boolean().nullable().optional(),
  })
  .passthrough();
export function parseCollector(content: string) {
  let value: unknown;
  try {
    value = JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch {
    throw new BadRequestException("无效 JSON");
  }
  const parsed = rawSchema.safeParse(value);
  if (!parsed.success)
    throw new BadRequestException(
      "Windows 字段无效：" +
        parsed.error.issues.map((x) => x.path.join(".")).join(", "),
    );
  const r = parsed.data;
  const serial =
    r.SerialNumber &&
    !/^(unknown|default string|to be filled by o\.e\.m\.|none|0+)$/i.test(
      r.SerialNumber,
    )
      ? r.SerialNumber
      : null;
  return {
    targetAssetId: r.TargetAssetId ?? null,
    hostname: r.Hostname,
    serial,
    collectorVersion: r.CollectorVersion ?? null,
    collectedAt: r.CollectedAt ? new Date(r.CollectedAt).toISOString() : null,
    os: r.OS ?? null,
    osVersion: r.OSVersion ?? null,
    osBuild: r.OSBuild ?? null,
    fullBuild: r.FullBuild ?? null,
    architecture: r.Architecture ?? null,
    ubr: r.UBR ?? null,
    software:
      r.InstalledSoftware?.map((x) => ({
        name: x.Name ?? null,
        version: x.Version ?? null,
        publisher: x.Publisher ?? null,
        raw: x,
      })) ?? null,
    kbs:
      r.InstalledKBs || r.KBDetails
        ? [
            ...new Set(
              [
                ...(r.InstalledKBs ?? []),
                ...(r.KBDetails ?? []).map((x) => x.KB),
              ].map((x) => x.toUpperCase()),
            ),
          ]
        : null,
    collectionStatus: r.CollectionStatus ?? null,
    kbInventoryComplete: r.KBInventoryComplete ?? null,
    softwareInventoryComplete: r.SoftwareInventoryComplete ?? null,
    rebootPending: r.RebootPending ?? null,
    extensions: value,
    assessmentSupport: {
      state: "not_assessed",
      limitations: [
        "采集资料不是漏洞判定；KB 数字不代表替代关系",
        "缺失版本、完整性、产品或补丁证据须保持未知",
      ],
    },
  };
}
