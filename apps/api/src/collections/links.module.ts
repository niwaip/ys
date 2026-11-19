import { requireActiveAsset } from "../assets/asset-state";
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
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DATABASE, type Database } from "../persistence/database";
import type { AuthorizedRequest } from "../auth/auth";
import { CollectionsModule, CollectionsService } from "./collections.module";
import { SoftwareModule, SoftwareService } from "../software/software.module";
import {
  ContainersModule,
  ContainerService,
} from "../containers/containers.module";
import { ImportsModule, ImportsService } from "../imports/imports.module";
import type { AssetVersionLink } from "../../../../packages/contracts/collections";
const input = z
  .object({
    assetId: z.uuid(),
    snapshotId: z.uuid(),
    kind: z.enum(["software", "container"]),
    objectId: z.uuid(),
    versionId: z.uuid(),
    basis: z.string().trim().min(1).max(2000),
    imageId: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();
export class CollectionLinksService {
  constructor(
    private readonly db: Database,
    private readonly collections: CollectionsService,
    private readonly software: SoftwareService,
    private readonly containers: ContainerService,
    private readonly imports: ImportsService,
  ) {}
  async create(
    customerId: string,
    value: z.infer<typeof input>,
    actor: string,
  ) {
    const snapshot = await this.collections.get(customerId, value.snapshotId);
    if (snapshot.assetId !== value.assetId)
      throw new ConflictException("采集快照属于其他目标");
    const version =
      value.kind === "software"
        ? await this.software.getVersion(
            customerId,
            value.objectId,
            value.versionId,
          )
        : await this.containers.getVersion(
            customerId,
            value.objectId,
            value.versionId,
          );
    const material = await this.imports.get(customerId, version.importId);
    const {
      id,
      contentHash,
      identity,
      target,
      entry,
      collectedAt,
      importedAt,
      sections,
    } = snapshot;
    const link: AssetVersionLink = {
      id: randomUUID(),
      customerId,
      assetId: value.assetId,
      kind: value.kind,
      objectId: value.objectId,
      versionId: value.versionId,
      importId: version.importId,
      contentHash: material.contentHash,
      basisType: "operator_declaration",
      declaredBy: actor,
      basis: value.basis,
      createdAt: new Date().toISOString(),
      snapshot: {
        id,
        contentHash,
        identity,
        target,
        entry,
        collectedAt,
        importedAt,
        sections,
      },
    };
    if (value.kind === "container") {
      const image = await this.containers.getVersion(
        customerId,
        value.objectId,
        value.versionId,
      );
      if (!image.identity.digest && !value.imageId)
        throw new BadRequestException(
          "镜像关联须提供完整ImageID或SBOM所声明digest，不能仅按标签关联",
        );
      link.imageIdentity = {
        imageId: value.imageId ?? null,
        digest: image.identity.digest,
        coverage:
          "操作员声明镜像关联；镜像SBOM不覆盖容器可写层、挂载卷或运行暴露",
      };
    } else if (value.imageId)
      throw new BadRequestException("软件关联不接受镜像ID");
    const hash = createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex");
    return this.db.transaction(async (session) => {
      await requireActiveAsset(session, customerId, value.assetId);
      const old = (
        await session.query(
          "SELECT details FROM asset_version_links WHERE customer_id=$1 AND input_hash=$2",
          [customerId, hash],
        )
      ).rows[0];
      if (old) return old.details as AssetVersionLink;
      await session.query(
        "INSERT INTO asset_version_links(id,customer_id,asset_id,snapshot_id,input_hash,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
        [
          link.id,
          customerId,
          value.assetId,
          value.snapshotId,
          hash,
          JSON.stringify(link),
        ],
      );
      return link;
    });
  }
  async get(customerId: string, id: string) {
    const row = (
      await this.db.query(
        "SELECT details FROM asset_version_links WHERE customer_id=$1 AND id=$2",
        [customerId, id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("该客户下未找到版本关联");
    return row.details as AssetVersionLink;
  }
  async forVersion(
    customerId: string,
    id: string,
    kind: string,
    objectId: string,
    versionId: string,
  ) {
    const link = await this.get(customerId, id);
    if (
      link.kind !== kind ||
      link.objectId !== objectId ||
      link.versionId !== versionId
    )
      throw new ConflictException("关联与所选对象输入版本不匹配");
    return link;
  }
  async list(customerId: string, assetId?: string, offset = 0, kind?: string) {
    return {
      items: (
        await this.db.query(
          "SELECT details FROM asset_version_links WHERE customer_id=$1 AND ($2::uuid IS NULL OR asset_id=$2::uuid) AND ($4::text IS NULL OR details->>'kind'=$4) ORDER BY created_at DESC,id LIMIT 100 OFFSET $3",
          [customerId, assetId ?? null, offset, kind ?? null],
        )
      ).rows.map((row) => row.details),
    };
  }
  async assessmentInput(customerId: string, snapshotId: string) {
    const snapshot = await this.collections.get(customerId, snapshotId);
    return {
      snapshotId: snapshot.id,
      contentHash: snapshot.contentHash,
      status: "unsupported",
      reason:
        "主机基础资料与原始Linux包清单暂没有匹配适配器；不是零漏洞。软件/镜像请显式选择已关联SBOM版本独立评估。",
    };
  }
}
@Controller("api/customers/:customerId/collections")
class LinksController {
  constructor(private readonly service: CollectionLinksService) {}
  @Post("links") create(req: AuthorizedRequest) {
    const value = input.safeParse(req.body);
    if (!value.success)
      throw new BadRequestException(
        "需明确主机快照、软件/镜像对象、输入版本与关联依据",
      );
    return this.service.create(
      req.params.customerId,
      value.data,
      req.operator.name,
    );
  }
  @Get("links") list(req: AuthorizedRequest) {
    const query = z
      .object({
        assetId: z.uuid().optional(),
        kind: z.enum(["software", "container"]).optional(),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
      })
      .safeParse(req.query);
    if (!query.success) throw new BadRequestException("资产编号或分页参数无效");
    return this.service.list(
      req.params.customerId,
      query.data.assetId,
      query.data.offset,
      query.data.kind,
    );
  }
  @Get("snapshots/:snapshotId/assessment-input") assessmentInput(
    req: AuthorizedRequest,
  ) {
    if (!z.uuid().safeParse(req.params.snapshotId).success)
      throw new BadRequestException("快照编号无效");
    return this.service.assessmentInput(
      req.params.customerId,
      req.params.snapshotId,
    );
  }
}
for (const method of ["create", "list", "assessmentInput"] as const)
  Req()(LinksController.prototype, method, 0);
Inject(CollectionLinksService)(LinksController, undefined, 0);
@Module({
  imports: [CollectionsModule, SoftwareModule, ContainersModule, ImportsModule],
  controllers: [LinksController],
  providers: [
    {
      provide: CollectionLinksService,
      inject: [
        DATABASE,
        CollectionsService,
        SoftwareService,
        ContainerService,
        ImportsService,
      ],
      useFactory: (
        db: Database,
        c: CollectionsService,
        s: SoftwareService,
        images: ContainerService,
        i: ImportsService,
      ) => new CollectionLinksService(db, c, s, images, i),
    },
  ],
  exports: [CollectionLinksService],
})
export class CollectionLinksModule {}
