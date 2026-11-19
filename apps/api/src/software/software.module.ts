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
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  DATABASE,
  type Database,
  type Queryable,
} from "../persistence/database";
import type { AuthorizedRequest } from "../auth/auth";
import type {
  Software,
  SoftwareVersion,
} from "../../../../packages/contracts/software";
import { parseCycloneDx } from "./cyclonedx";
const objectColumns = `id,customer_id AS "customerId",name,created_at AS "createdAt"`;
const versionColumns = `id,customer_id AS "customerId",software_id AS "softwareId",version,import_id AS "importId",created_at AS "createdAt",details`;
function object(row: Record<string, unknown>): Software {
  return {
    ...row,
    kind: "software",
    createdAt: new Date(row.createdAt as string).toISOString(),
  } as Software;
}
function version(row: Record<string, unknown>): SoftwareVersion {
  const { details, ...base } = row;
  return {
    ...base,
    ...(details as object),
    createdAt: new Date(row.createdAt as string).toISOString(),
  } as SoftwareVersion;
}
export class SoftwareService {
  constructor(private readonly db: Database) {}
  async create(customer: string, name: string) {
    const r = await this.db.query(
      `INSERT INTO software_objects(id,customer_id,name) VALUES($1,$2,$3) RETURNING ${objectColumns}`,
      [randomUUID(), customer, name],
    );
    return object(r.rows[0]);
  }
  async list(customer: string) {
    const r = await this.db.query(
      `SELECT ${objectColumns} FROM software_objects WHERE customer_id=$1 ORDER BY created_at DESC,id LIMIT 100`,
      [customer],
    );
    return { items: r.rows.map(object) };
  }
  async get(customer: string, id: string, session: Queryable = this.db) {
    const r = await session.query(
      `SELECT ${objectColumns} FROM software_objects WHERE customer_id=$1 AND id=$2`,
      [customer, id],
    );
    if (!r.rows.length) throw new NotFoundException("该客户下未找到软件对象");
    const v = await session.query(
      `SELECT ${versionColumns} FROM software_versions WHERE customer_id=$1 AND software_id=$2 ORDER BY created_at DESC,id`,
      [customer, id],
    );
    return { ...object(r.rows[0]), versions: v.rows.map(version) };
  }
  async getVersion(
    customer: string,
    softwareId: string,
    id: string,
    session: Queryable = this.db,
  ) {
    const r = await session.query(
      `SELECT ${versionColumns} FROM software_versions WHERE customer_id=$1 AND software_id=$2 AND id=$3`,
      [customer, softwareId, id],
    );
    if (!r.rows.length)
      throw new NotFoundException("该客户软件下未找到输入版本");
    return version(r.rows[0]);
  }
  async upload(
    customer: string,
    softwareId: string,
    fileName: string,
    content: string,
  ) {
    const parsed = parseCycloneDx(content);
    if(parsed.rootType==="container")throw new BadRequestException("容器镜像 SBOM 请使用容器入口，不能关联为软件应用");
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    return this.db.transaction(async (session) => {
      await this.get(customer, softwareId, session);
      const existing = await session.query(
        `SELECT id,result FROM import_materials WHERE customer_id=$1 AND format='cyclonedx-json' AND content_hash=$2`,
        [customer, hash],
      );
      if (existing.rows.length) {
        const result = existing.rows[0].result as {
          softwareId: string;
          versionId: string;
        };
        if (result.softwareId !== softwareId)
          throw new ConflictException(
            "相同客户的同一资料已关联其他软件；请使用原对象或提供新的来源资料",
          );
        return {
          ...(await this.getVersion(
            customer,
            softwareId,
            result.versionId,
            session,
          )),
          replayed: true,
        };
      }
      const id = randomUUID(),
        importId = randomUUID(),
        committedAt = new Date().toISOString();
      const result = {
        softwareId,
        versionId: id,
        status: "committed",
        committedAt,
        policy: "atomic",
        canCommit: false,
        mapping: { components: "softwareVersion.components" },
        rows: parsed.components.map((c, i) => ({
          row: i + 1,
          status: "imported",
          issues: c.issues,
          componentId: c.id,
        })),
      };
      const saved = await session.query(
        `INSERT INTO import_materials(id,customer_id,format,file_name,content,content_hash,result) VALUES($1,$2,'cyclonedx-json',$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
        [importId, customer, fileName, content, hash, JSON.stringify(result)],
      );
      if (!saved.rows.length)
        throw new ConflictException("资料同时上传，请重试读取原输入版本");
      const r = await session.query(
        `INSERT INTO software_versions(id,customer_id,software_id,version,import_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING ${versionColumns}`,
        [
          id,
          customer,
          softwareId,
          parsed.version,
          importId,
          JSON.stringify({
            components: parsed.components,
            collectedAt: parsed.collectedAt,
            issues: parsed.issues,
          }),
        ],
      );
      return { ...version(r.rows[0]), replayed: false };
    });
  }
}
@Controller("api/customers/:customerId/software")
class SoftwareController {
  constructor(private readonly software: SoftwareService) {}
  @Post() create(req: AuthorizedRequest) {
    const r = z
      .object({ name: z.string().trim().min(1).max(200) })
      .strict()
      .safeParse(req.body);
    if (!r.success)
      throw new BadRequestException("软件名称必填，最多 200 字符");
    return this.software.create(req.params.customerId, r.data.name);
  }
  @Get() list(req: AuthorizedRequest) {
    return this.software.list(req.params.customerId);
  }
  @Get(":softwareId") get(req: AuthorizedRequest) {
    this.valid(req);
    return this.software.get(req.params.customerId, req.params.softwareId);
  }
  @Get(":softwareId/versions/:versionId") getVersion(req: AuthorizedRequest) {
    this.valid(req);
    if (!z.uuid().safeParse(req.params.versionId).success)
      throw new BadRequestException("输入版本编号无效");
    return this.software.getVersion(
      req.params.customerId,
      req.params.softwareId,
      req.params.versionId,
    );
  }
  @Post(":softwareId/sbom") upload(req: AuthorizedRequest) {
    this.valid(req);
    const r = z
      .object({
        fileName: z.string().trim().min(1).max(200),
        content: z.string().min(1).max(500000),
      })
      .strict()
      .safeParse(req.body);
    if (!r.success)
      throw new BadRequestException(
        "上传需要 fileName 和 content，最多 500000 字节",
      );
    return this.software.upload(
      req.params.customerId,
      req.params.softwareId,
      r.data.fileName,
      r.data.content,
    );
  }
  private valid(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.softwareId).success)
      throw new BadRequestException("软件编号无效");
  }
}
for (const method of ["create", "list", "get", "getVersion", "upload"] as const)
  Req()(SoftwareController.prototype, method, 0);
Inject(SoftwareService)(SoftwareController, undefined, 0);
@Module({
  controllers: [SoftwareController],
  providers: [
    {
      provide: SoftwareService,
      inject: [DATABASE],
      useFactory: (db: Database) => new SoftwareService(db),
    },
  ],
  exports: [SoftwareService],
})
export class SoftwareModule {}
