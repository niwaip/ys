import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Inject,
  Module,
  NotFoundException,
  Post,
  Req,
  type DynamicModule,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DATABASE, type Database } from "../persistence/database";
import { requireActiveAsset } from "../assets/asset-state";
import {
  ContainersModule,
  ContainerService,
} from "../containers/containers.module";
import {
  CollectionsModule,
  CollectionsService,
} from "../collections/collections.module";
import type { AuthorizedRequest } from "../auth/auth";
import {
  generatedImageSchema,
  type RuntimeImage,
  type ContainerSource,
  type ContainerRuntimeSummary,
} from "../../../../packages/contracts/container-runtime";
export const manualImageInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    fileName: z.string().min(1).max(200),
    content: z.string().min(1).max(20000000),
    assetId: z.uuid().optional(),
    snapshotId: z.uuid().optional(),
  })
  .strict()
  .refine((x) => !x.snapshotId || !!x.assetId, "快照需明确主机");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class ContainerRuntimeService {
  constructor(
    readonly db: Database,
    readonly containers: ContainerService,
    readonly collections: CollectionsService,
  ) {}
  async import(
    customer: string,
    input: z.infer<typeof manualImageInput>,
    actor: string,
    basis: ContainerSource["basis"] = "operator_declaration",
  ) {
    if (input.assetId)
      await this.collections.assertTarget(customer, input.assetId);
    const snapshot = input.snapshotId
      ? await this.collections.get(customer, input.snapshotId)
      : null;
    if (snapshot && snapshot.assetId !== input.assetId)
      throw new ConflictException("快照与主机不匹配");
    let content = input.content,
      generated: z.infer<typeof generatedImageSchema> | undefined;
    try {
      const raw = JSON.parse(content);
      if (raw.schemaVersion === "ys-image/1") {
        const p = generatedImageSchema.safeParse(raw);
        if (!p.success) throw new BadRequestException("离线镜像产物格式无效");
        generated = p.data;
        content = JSON.stringify(generated.sbom);
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException("镜像资料须为JSON");
    }
    if (
      generated &&
      snapshot?.identity.machineId &&
      generated.host.machineId !== snapshot.identity.machineId
    )
      throw new ConflictException("生成资料的主机身份与快照不匹配");
    const inventory =
      generated && input.snapshotId
        ? await this.inventory(customer, input.snapshotId)
        : null;
    const observed = inventory?.items.find(
      (i) => i.imageId === generated!.image.imageId,
    );
    if (basis === "docker_image_observation" && !observed)
      throw new ConflictException("生成镜像与主机目录不匹配");
    return this.db.transaction(async (tx) => {
      if (input.assetId) await requireActiveAsset(tx, customer, input.assetId);
      const prior = (
        await tx.query(
          "SELECT result FROM import_materials WHERE customer_id=$1 AND format='container-cyclonedx-json' AND content_hash=$2",
          [customer, hash(content)],
        )
      ).rows[0];
      const containerId = prior
        ? String((prior.result as { containerId: string }).containerId)
        : (
            await this.containers.create(
              customer,
              input.name,
              generated ? "主机脚本生成" : "手动SBOM上传",
              tx,
            )
          ).id;
      const version = prior
        ? await this.containers.getVersion(
            customer,
            containerId,
            String((prior.result as { versionId: string }).versionId),
            tx,
          )
        : await this.containers.upload(
            customer,
            containerId,
            { fileName: input.fileName, content },
            tx,
          );
      const inputHash = hash(
        JSON.stringify({
          assetId: input.assetId ?? null,
          snapshotId: input.snapshotId ?? null,
          versionId: version.id,
          basis,
          artifactHash: hash(input.content),
          imageId: generated?.image.imageId ?? null,
        }),
      );
      const old = (
        await tx.query(
          "SELECT details FROM container_sources WHERE customer_id=$1 AND input_hash=$2",
          [customer, inputHash],
        )
      ).rows[0];
      if (old) return { version, source: old.details as ContainerSource };
      const source: ContainerSource = {
        id: randomUUID(),
        customerId: customer,
        assetId: input.assetId ?? null,
        snapshotId: input.snapshotId ?? null,
        snapshotHash: snapshot?.contentHash ?? null,
        containerId: version.containerId,
        versionId: version.id,
        contentHash: hash(content),
        artifactHash: hash(input.content),
        basis,
        imageId: generated?.image.imageId ?? null,
        architecture:
          generated?.image.architecture ?? version.identity.architecture,
        containers: observed?.containers ?? [],
        generator: generated?.toolVersion ?? null,
        generatedAt: generated?.generatedAt ?? version.collectedAt,
        actor,
        createdAt: new Date().toISOString(),
        coverage:
          "镜像组件观测；不覆盖容器可写层、挂载卷或运行暴露，不代表主机已确认受影响",
      };
      await tx.query(
        "INSERT INTO container_sources(id,customer_id,asset_id,container_id,version_id,input_hash,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
        [
          source.id,
          customer,
          source.assetId,
          source.containerId,
          source.versionId,
          inputHash,
          JSON.stringify(source),
        ],
      );
      await tx.query(
        "INSERT INTO container_source_artifacts(customer_id,source_id,content,content_hash) VALUES($1,$2,$3,$4)",
        [customer, source.id, input.content, source.artifactHash],
      );
      return { version, source };
    });
  }
  async inventory(customer: string, snapshotId: string) {
    const row = await this.collections.row(customer, snapshotId);
    const normalized =
      row.normalized as import("../../../../packages/contracts/collections").HostCollection;
    const imageRows = z
      .array(
        z.object({
          imageId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
          repository: z.string().nullable().optional(),
          tag: z.string().nullable().optional(),
          digest: z.string().nullable().optional(),
        }),
      )
      .max(10000)
      .safeParse(normalized.sections.images?.data);
    const containerRows = z
      .array(
        z.object({
          containerId: z.string().regex(/^[0-9a-f]{64}$/),
          imageId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
          name: z.string(),
          state: z.string(),
        }),
      )
      .max(10000)
      .safeParse(normalized.sections.containers?.data);
    const groups = new Map<string, RuntimeImage>();
    if (
      imageRows.success &&
      ["acquired", "partial"].includes(normalized.sections.images?.status ?? "")
    )
      for (const image of imageRows.data) {
        let item = groups.get(image.imageId);
        if (!item) {
          item = {
            imageId: image.imageId,
            repositories: [],
            tags: [],
            digests: [],
            containers: containerRows.success
              ? containerRows.data
                  .filter((c) => c.imageId === image.imageId)
                  .map(({ imageId, ...c }) => c)
              : [],
          };
          groups.set(image.imageId, item);
        }
        for (const [key, value] of [
          ["repositories", image.repository],
          ["tags", image.tag],
          ["digests", image.digest],
        ] as const)
          if (value && value !== "<none>" && !item[key].includes(value))
            item[key].push(value);
      }
    return {
      snapshotId,
      assetId: String(row.asset_id),
      contentHash: String(row.content_hash),
      collectedAt: normalized.collectedAt,
      imagesStatus: normalized.sections.images?.status ?? "not_collected",
      containersStatus:
        normalized.sections.containers?.status ?? "not_collected",
      items: [...groups.values()],
      issues: [
        ...(!imageRows.success ? ["镜像目录未取得或格式不兼容"] : []),
        ...(!containerRows.success ? ["运行容器关系未知"] : []),
      ],
    };
  }
  async artifact(customer: string, id: string) {
    const r = await this.db.query(
      "SELECT content,content_hash AS hash FROM container_source_artifacts WHERE customer_id=$1 AND source_id=$2",
      [customer, id],
    );
    if (!r.rows.length)
      throw new NotFoundException("该客户下未找到镜像原始产物");
    return r.rows[0];
  }
  async sources(customer: string, assetId?: string) {
    if (assetId) await this.collections.assertTarget(customer, assetId);
    const rows = await this.db.query(
      "SELECT details FROM container_sources WHERE customer_id=$1 AND ($2::uuid IS NULL OR asset_id=$2) ORDER BY created_at DESC,id LIMIT 100",
      [customer, assetId ?? null],
    );
    return { items: rows.rows.map((r) => r.details as ContainerSource) };
  }
  async summary(
    customer: string,
    assetId?: string,
  ): Promise<ContainerRuntimeSummary> {
    if (assetId) await this.collections.assertTarget(customer, assetId);
    const rows = await this.db.query(
      "SELECT s.details FROM container_sources s LEFT JOIN assets a ON a.customer_id=s.customer_id AND a.id=s.asset_id WHERE s.customer_id=$1 AND ($2::uuid IS NULL OR s.asset_id=$2) AND (s.asset_id IS NULL OR a.deleted_at IS NULL) ORDER BY s.created_at DESC,s.id",
      [customer, assetId ?? null],
    );
    const sources = rows.rows.map((r) => r.details as ContainerSource),
      latest = new Map<string, ContainerSource>();
    for (const s of sources)
      if (!latest.has(`${s.assetId}:${s.imageId ?? s.versionId}`))
        latest.set(`${s.assetId}:${s.imageId ?? s.versionId}`, s);
    const tasks = await this.db.query(
      "SELECT CASE WHEN g.status='assessing' THEN COALESCE(v.status,g.status) ELSE g.status END AS status FROM container_generation_jobs g JOIN assets a ON a.customer_id=g.customer_id AND a.id=g.asset_id LEFT JOIN vulnerability_jobs v ON v.customer_id=g.customer_id AND v.id=(g.details->>'assessmentId')::uuid WHERE g.customer_id=$1 AND ($2::uuid IS NULL OR g.asset_id=$2) AND a.deleted_at IS NULL",
      [customer, assetId ?? null],
    );
    return {
      hosts: new Set(sources.map((s) => s.assetId).filter(Boolean)).size,
      observedImages: new Set(
        [...latest.values()].map((s) => s.imageId).filter(Boolean),
      ).size,
      generatedVersions: new Set(sources.map((s) => s.versionId)).size,
      runningContainers: new Set(
        [...latest.values()].flatMap((s) =>
          s.containers
            .filter((c) => c.state === "running")
            .map((c) => `${s.assetId}:${c.containerId}`),
        ),
      ).size,
      pending: tasks.rows.filter((r) =>
        ["queued", "generating", "assessing", "running"].includes(
          String(r.status),
        ),
      ).length,
      succeeded: tasks.rows.filter((r) => r.status === "succeeded").length,
      failed: tasks.rows.filter((r) =>
        ["failed", "unavailable", "timed_out", "interrupted"].includes(
          String(r.status),
        ),
      ).length,
    };
  }
}
@Controller("api/customers/:customerId/container-runtime")
class RuntimeController {
  constructor(private service: ContainerRuntimeService) {}
  @Post("imports") import(req: AuthorizedRequest) {
    const p = manualImageInput.safeParse(req.body);
    if (!p.success) throw new BadRequestException("镜像资料或主机输入无效");
    return this.service.import(
      req.params.customerId,
      p.data,
      req.operator.name,
    );
  }
  @Get("sources") sources(req: AuthorizedRequest) {
    const p = z
      .object({ assetId: z.uuid().optional() })
      .strict()
      .safeParse(req.query);
    if (!p.success) throw new BadRequestException("主机参数无效");
    return this.service.sources(req.params.customerId, p.data.assetId);
  }
  @Get("sources/:id/artifact") artifact(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.id).success)
      throw new BadRequestException("来源编号无效");
    return this.service.artifact(req.params.customerId, req.params.id);
  }
  @Get("summary") summary(req: AuthorizedRequest) {
    const p = z
      .object({ assetId: z.uuid().optional() })
      .strict()
      .safeParse(req.query);
    if (!p.success) throw new BadRequestException("主机参数无效");
    return this.service.summary(req.params.customerId, p.data.assetId);
  }
}
for (const m of ["import", "sources", "summary", "artifact"] as const)
  Req()(RuntimeController.prototype, m, 0);
Inject(ContainerRuntimeService)(RuntimeController, undefined, 0);
@Module({
  imports: [ContainersModule, CollectionsModule],
  controllers: [RuntimeController],
  providers: [
    {
      provide: ContainerRuntimeService,
      inject: [DATABASE, ContainerService, CollectionsService],
      useFactory: (
        db: Database,
        containers: ContainerService,
        collections: CollectionsService,
      ) => new ContainerRuntimeService(db, containers, collections),
    },
  ],
  exports: [ContainerRuntimeService],
})
export class ContainerRuntimeModule {}
