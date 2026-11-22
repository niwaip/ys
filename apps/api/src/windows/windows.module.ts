import { requireActiveAsset } from "../assets/asset-state";
import { NetBoxService } from "../netbox/netbox.module";
import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Req,
  Inject,
  Module,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DATABASE, type Database } from "../persistence/database";
import type { AuthorizedRequest } from "../auth/auth";
import { parseCollector } from "./collector";
const upload = z
  .object({
    fileName: z.string().trim().min(1).max(200),
    content: z.string().min(1),
  })
  .strict();
const cols = `id,customer_id AS "customerId",file_name AS "fileName",content_hash AS "contentHash",content,imported_at AS "importedAt",result`;
function serialize(r: Record<string, unknown>): Record<string, unknown> {
  const { result, ...base } = r;
  return {
    ...base,
    ...(result as object),
    importedAt: new Date(r.importedAt as string).toISOString(),
  };
}
export class WindowsService {
  constructor(
    private db: Database,
    private readonly netbox: NetBoxService,
  ) {}
  async get(customer: string, id: string) {
    const r = await this.db.query(
      `SELECT ${cols} FROM import_materials WHERE customer_id=$1 AND id=$2 AND format='windows-json'`,
      [customer, id],
    );
    if (!r.rows.length)
      throw new NotFoundException("该客户下未找到 Windows 资料");
    return serialize(r.rows[0]);
  }
  async getSnapshot(customer: string, id: string) {
    const r = await this.db.query(
      'SELECT id,customer_id AS "customerId",asset_id AS "assetId",import_id AS "importId",snapshot FROM windows_snapshots WHERE customer_id=$1 AND id=$2',
      [customer, id],
    );
    if (!r.rows.length) throw new NotFoundException("该客户下未找到快照");
    return r.rows[0];
  }
  async list(customer: string, assetId?: string) {
    const r = await this.db.query(
      `SELECT ${cols} FROM import_materials WHERE customer_id=$1 AND format='windows-json' AND ($2::text IS NULL OR result->>'assetId'=$2::text) ORDER BY imported_at DESC,id LIMIT 100`,
      [customer, assetId ?? null],
    );
    return {
      items: r.rows.map((x) => {
        const { content, ...item } = serialize(x);
        return item;
      }),
    };
  }
  async ingest(customer: string, fileName: string, content: string) {
    if (Buffer.byteLength(content, "utf8") > 500000 || content.includes("\0"))
      throw new BadRequestException("JSON 最多 500000 UTF-8 字节且不能含 NUL");
    const snapshot = parseCollector(content),
      hash = createHash("sha256").update(content).digest("hex");
    const linked =
      this.netbox.enabled &&
      (snapshot.collectorVersion === null || snapshot.collectorVersion === "1")
        ? await this.netbox.resolveSerial(customer, snapshot.serial)
        : null;
    return this.db.transaction(async (s) => {
      const old = await s.query(
        `SELECT ${cols} FROM import_materials WHERE customer_id=$1 AND format='windows-json' AND content_hash=$2`,
        [customer, hash],
      );
      if (old.rows.length) return { ...serialize(old.rows[0]), replayed: true };
      const id = randomUUID();
      let assetId: string | null = linked;
      const matches = snapshot.serial
        ? (
            await s.query(
              `SELECT asset_id FROM windows_identities WHERE customer_id=$1 AND source_ref=$2`,
              [customer, snapshot.serial],
            )
          ).rows
        : [];
      if (!this.netbox.enabled && matches.length === 1)
        assetId = String(matches[0].asset_id);
      const names = await s.query(
        "SELECT id FROM assets WHERE customer_id=$1 AND name=$2",
        [customer, snapshot.hostname],
      );
      const unsupported =
        snapshot.collectorVersion !== null && snapshot.collectorVersion !== "1";
      const ambiguous =
        unsupported ||
        (this.netbox.enabled && !assetId) ||
        (!assetId && (!snapshot.serial || names.rows.length > 0));
      const result = {
        status: unsupported
          ? "unsupported_version"
          : ambiguous
            ? "pending_confirmation"
            : "imported",
        adapterVersion: "windows-bat/1",
        assetId,
        snapshotId: ambiguous ? null : randomUUID(),
        snapshot,
        issues: unsupported
          ? ["不支持该采集器版本；已保留资料，未建立快照"]
          : ambiguous
            ? ["缺少稳定序列号或同名资产身份待确认；未合并、未建立快照"]
            : [],
      };
      await s.query(
        `INSERT INTO import_materials(id,customer_id,format,file_name,content,content_hash,result) VALUES($1,$2,'windows-json',$3,$4,$5,$6::jsonb)`,
        [id, customer, fileName, content, hash, JSON.stringify(result)],
      );
      if (!ambiguous) {
        if (!assetId) {
          assetId = randomUUID();
          await s.query(
            `INSERT INTO assets(id,customer_id,name,kind,source,source_ref,import_id,collected_at) VALUES($1,$2,$3,'host','windows-bat',$4,$5,$6)`,
            [
              assetId,
              customer,
              snapshot.hostname,
              snapshot.serial,
              id,
              snapshot.collectedAt,
            ],
          );
          await s.query(
            "INSERT INTO windows_identities(customer_id,source_ref,asset_id) VALUES($1,$2,$3)",
            [customer, snapshot.serial, assetId],
          );
          result.assetId = assetId;
        }
        await requireActiveAsset(s, customer, assetId!);
        await s.query(
          "INSERT INTO windows_snapshots(id,customer_id,asset_id,import_id,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)",
          [result.snapshotId, customer, assetId, id, JSON.stringify(snapshot)],
        );
        await s.query(
          "UPDATE import_materials SET result=$3::jsonb WHERE customer_id=$1 AND id=$2",
          [customer, id, JSON.stringify(result)],
        );
      }
      const saved = await s.query(
        `SELECT ${cols} FROM import_materials WHERE customer_id=$1 AND id=$2`,
        [customer, id],
      );
      return serialize(saved.rows[0]);
    });
  }
}
@Controller("api/customers/:customerId/windows")
class WindowsController {
  constructor(private service: WindowsService) {}
  @Post("imports") ingest(req: AuthorizedRequest) {
    const r = upload.safeParse(req.body);
    if (!r.success) throw new BadRequestException("需 fileName 和 content");
    return this.service.ingest(
      req.params.customerId,
      r.data.fileName,
      r.data.content,
    );
  }
  @Get("imports") list(req: AuthorizedRequest) {
    const input = z
      .object({ assetId: z.uuid().optional() })
      .strict()
      .safeParse(req.query);
    if (!input.success) throw new BadRequestException("评估资产编号无效");
    return this.service.list(req.params.customerId, input.data.assetId);
  }
  @Get("snapshots/:snapshotId") snapshot(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.snapshotId).success)
      throw new BadRequestException("无效编号");
    return this.service.getSnapshot(
      req.params.customerId,
      req.params.snapshotId,
    );
  }
  @Get("imports/:importId") get(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.importId).success)
      throw new BadRequestException("无效编号");
    return this.service.get(req.params.customerId, req.params.importId);
  }
}
for (const method of ["ingest", "list", "get", "snapshot"] as const)
  Req()(WindowsController.prototype, method, 0);
Inject(WindowsService)(WindowsController, undefined, 0);
@Module({
  controllers: [WindowsController],
  providers: [
    {
      provide: WindowsService,
      inject: [DATABASE, NetBoxService],
      useFactory: (db: Database, netbox: NetBoxService) =>
        new WindowsService(db, netbox),
    },
  ],
  exports: [WindowsService],
})
export class WindowsModule {}
