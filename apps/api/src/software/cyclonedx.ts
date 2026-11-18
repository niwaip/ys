import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { SoftwareComponent } from "../../../../packages/contracts/software";
const component: z.ZodType<any> = z.lazy(() =>
  z
    .object({
      type: z.enum([
        "application",
        "framework",
        "library",
        "container",
        "platform",
        "operating-system",
        "device",
        "device-driver",
        "firmware",
        "file",
        "machine-learning-model",
        "data",
        "cryptographic-asset",
      ]),
      name: z.string().trim().min(1).max(500),
      version: z.string().trim().min(1).max(500).optional(),
      purl: z
        .string()
        .regex(/^pkg:[a-z][a-z0-9.+-]*\/[^\s]+$/)
        .optional(),
      cpe: z.string().min(1).optional(),
      "bom-ref": z.string().min(1).optional(),
      components: z.array(component).optional(),
    })
    .passthrough(),
);
const schema = z
  .object({
    bomFormat: z.literal("CycloneDX"),
    specVersion: z.enum(["1.4", "1.5", "1.6"]),
    version: z.number().int().positive().optional(),
    metadata: z
      .object({
        timestamp: z.iso.datetime({ offset: true }).optional(),
        component: component.optional(),
      })
      .passthrough()
      .optional(),
    components: z.array(component),
  })
  .passthrough();
export function parseCycloneDx(content: string) {
  if (Buffer.byteLength(content, "utf8") > 500000 || content.includes("\0"))
    throw new BadRequestException("SBOM 最多 500000 UTF-8 字节且不能含 NUL");
  let json: unknown;
  try {
    json = JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch {
    throw new BadRequestException("无效 JSON；仅支持 CycloneDX JSON 1.4–1.6");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new BadRequestException(
      "结构不受支持；需 CycloneDX JSON 1.4–1.6、components 数组及有效组件名称/类型/PURL",
    );
  const components: SoftwareComponent[] = [];
  const refs = new Set<string>();
  function walk(items: any[], parentRef: string | null, depth: number) {
    if (depth > 30) throw new BadRequestException("组件嵌套最多 30 层");
    for (const c of items) {
      if (components.length >= 1000)
        throw new BadRequestException("最多 1000 个组件");
      const ref = c["bom-ref"] ?? null;
      if (ref && refs.has(ref))
        throw new BadRequestException("组件 bom-ref 重复，无法确定关系");
      if (ref) refs.add(ref);
      const issues: string[] = [];
      if (!c.version) issues.push("组件版本未知，漏洞匹配可能不完整");
      const ecosystem = c.purl?.match(/^pkg:([^/]+)\//)?.[1] ?? null;
      if (!ecosystem) issues.push("包生态未知，需补充 PURL");
      const id = randomUUID();
      components.push({
        id,
        name: c.name,
        version: c.version ?? null,
        purl: c.purl ?? null,
        cpe: c.cpe ?? null,
        ecosystem,
        bomRef: ref,
        parentRef,
        issues,
        raw: c,
      });
      walk(c.components ?? [], ref ?? id, depth + 1);
    }
  }
  walk(parsed.data.components, null, 0);
  const version = parsed.data.metadata?.component?.version ?? null;
  return {
    components,
    version,
    collectedAt: parsed.data.metadata?.timestamp
      ? new Date(parsed.data.metadata.timestamp).toISOString()
      : null,
    issues: version ? [] : ["软件版本未知；输入快照不代表已知发布版本"],
  };
}
