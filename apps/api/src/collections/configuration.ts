import {
  collectionScope,
  type HostCollection,
} from "../../../../packages/contracts/collections";
import type { CollectionsService } from "./collections.module";
import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Inject,
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
import { requireActiveAsset } from "../assets/asset-state";
import type { AuthorizedRequest } from "../auth/auth";
import {
  collectionConfiguration,
  type CollectionConfiguration,
  type ConfigurationRun,
} from "../../../../packages/contracts/collection-configuration";
import type { CollectionJobsService } from "./jobs.module";
export class CollectionConfigurationService {
  constructor(
    private readonly db: Database,
    private readonly jobs: CollectionJobsService,
    private readonly collections: CollectionsService,
  ) {}
  async onModuleInit() {
    await this.db.query(
      "UPDATE collection_configuration_runs SET details=jsonb_set(details,'{items}',(SELECT jsonb_agg(CASE WHEN i->>'status'='submitting' THEN jsonb_set(i,'{status}','\"interrupted\"'::jsonb) ELSE i END) FROM jsonb_array_elements(details->'items') i)) WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(details->'items') i WHERE i->>'status'='submitting')",
    );
  }
  private async target(
    db: Queryable,
    customer: string,
    id: string,
    config?: CollectionConfiguration,
  ) {
    const row = (
      await db.query(
        "SELECT attributes,deleted_at FROM assets WHERE customer_id=$1 AND id=$2",
        [customer, id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("该客户下未找到资产");
    if (row.deleted_at) throw new ConflictException("资产已删除");
    const attrs = row.attributes as Record<string, unknown>;
    const native = (attrs.netbox as { objectType?: string } | undefined)
      ?.objectType;
    if (
      config &&
      ((native === "virtual-machine" && config.category !== "vm") ||
        (native === "device" && config.category === "vm"))
    )
      throw new ConflictException("配置类型与NetBox原生身份不符");
  }
  async get(customer: string, id: string) {
    await this.target(this.db, customer, id);
    return (
      (
        await this.db.query(
          "SELECT details FROM collection_configurations WHERE customer_id=$1 AND asset_id=$2",
          [customer, id],
        )
      ).rows[0]?.details ?? null
    );
  }
  async save(customer: string, id: string, input: CollectionConfiguration) {
    await this.collections.assertTarget(customer, id);
    return this.db.transaction(async (db) => {
      await requireActiveAsset(db, customer, id);
      await this.target(db, customer, id, input);
      await db.query(
        "INSERT INTO collection_configurations(customer_id,asset_id,details) VALUES($1,$2,$3::jsonb) ON CONFLICT(customer_id,asset_id) DO UPDATE SET details=excluded.details",
        [customer, id, JSON.stringify(input)],
      );
      return input;
    });
  }
  async run(
    customer: string,
    assetId: string,
    key: string,
    expected?: CollectionConfiguration,
  ) {
    await this.collections.assertTarget(customer, assetId);
    const stored = await this.get(customer, assetId);
    if (!stored) throw new BadRequestException("请先保存配置");
    const config = collectionConfiguration.parse(stored);
    const hash = createHash("sha256")
      .update(JSON.stringify(config))
      .digest("hex");
    if (expected && JSON.stringify(expected) !== JSON.stringify(config))
      throw new ConflictException("配置已被修改，请刷新核对后重试");
    const id = randomUUID();
    const reservation = await this.db.transaction(async (db) => {
      await requireActiveAsset(db, customer, assetId);
      const old = (
        await db.query(
          "SELECT id,input_hash,details FROM collection_configuration_runs WHERE customer_id=$1 AND asset_id=$2 AND idempotency_key=$3",
          [customer, assetId, key],
        )
      ).rows[0];
      if (old) {
        if (old.input_hash !== hash)
          throw new ConflictException("此幂等键对应其他配置");
        return { existing: true, run: old.details as ConfigurationRun };
      }
      const run: ConfigurationRun = {
        id,
        assetId,
        configuration: config,
        createdAt: new Date().toISOString(),
        items: config.items
          .filter((i) => i.enabled)
          .map((i) => ({
            content: i.content,
            status: i.method === "automatic" ? "submitting" : "awaiting_input",
          })),
      };
      if (!run.items.length) throw new BadRequestException("至少选择一项内容");
      await db.query(
        "INSERT INTO collection_configuration_runs(id,customer_id,asset_id,idempotency_key,input_hash,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
        [id, customer, assetId, key, hash, JSON.stringify(run)],
      );
      return { existing: false, run };
    });
    if (reservation.existing) return this.read(customer, reservation.run.id);
    const run = reservation.run;
    for (const item of run.items) {
      if (item.status !== "submitting") continue;
      const setting = config.items.find((s) => s.content === item.content)!;
      try {
        const job = (await this.jobs.submit(customer, {
          assetId,
          profileId: setting.profileId!,
          scope: item.content === "docker" ? "container-inventory" : "basic",
          method: "ssh",
          idempotencyKey: `configuration:${id}:${item.content}`,
          message:
            item.content === "software"
              ? "收集系统包及可取得的软件清单；不自动生成应用依赖或评估"
              : "配置项采集",
        })) as { id: string; status: string };
        item.jobId = job.id;
        item.status = job.status;
      } catch (e) {
        item.status = "failed";
        item.error = (e as Error).message;
      }
      await this.db.transaction(async (db) => {
        const current = (
          await db.query(
            "SELECT details FROM collection_configuration_runs WHERE customer_id=$1 AND id=$2 FOR UPDATE",
            [customer, id],
          )
        ).rows[0].details as ConfigurationRun;
        current.items = current.items.map((saved) =>
          saved.content === item.content ? item : saved,
        );
        await db.query(
          "UPDATE collection_configuration_runs SET details=$3::jsonb WHERE customer_id=$1 AND id=$2",
          [customer, id, JSON.stringify(current)],
        );
      });
    }
    return this.read(customer, id);
  }
  async read(customer: string, id: string) {
    const row = (
      await this.db.query(
        "SELECT details FROM collection_configuration_runs WHERE customer_id=$1 AND id=$2",
        [customer, id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("未找到配置采集批次");
    const run = row.details as ConfigurationRun;
    for (const item of run.items)
      if (item.jobId) {
        const job = (await this.jobs.get(customer, item.jobId)) as {
          status: string;
          snapshotId: string | null;
          error: string | null;
        };
        item.status = job.status;
        item.snapshotId = job.snapshotId;
        item.error = job.error;
      }
    return run;
  }
  async attach(
    customer: string,
    id: string,
    content: string,
    snapshotId: string,
  ) {
    return this.db.transaction(async (db) => {
      const row = (
        await db.query(
          "SELECT details FROM collection_configuration_runs WHERE customer_id=$1 AND id=$2 FOR UPDATE",
          [customer, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("未找到配置采集批次");
      const run = row.details as ConfigurationRun;
      await requireActiveAsset(db, customer, run.assetId);
      const item = run.items.find((i) => i.content === content);
      if (!item) throw new BadRequestException("此内容不属于批次");
      if (item.jobId || (item.snapshotId && item.snapshotId !== snapshotId))
        throw new ConflictException("此分项已有固定结果，请发起新批次");
      const snapshot = (
        await db.query(
          "SELECT asset_id,normalized,entry FROM collection_snapshots WHERE customer_id=$1 AND id=$2",
          [customer, snapshotId],
        )
      ).rows[0];
      if (!snapshot) throw new NotFoundException("未找到资料版本");
      if (snapshot.asset_id !== run.assetId)
        throw new ConflictException("资料属于其他资产");
      const method = run.configuration.items.find(
        (i) => i.content === content,
      )?.method;
      if (
        (method === "manual" && snapshot.entry !== "manual") ||
        (method === "script" && snapshot.entry !== "upload")
      )
        throw new ConflictException("资料来源与此分项配置方式不符");
      const data = snapshot.normalized as HostCollection;
      const container = collectionScope(data) === "container-inventory";
      if ((content === "docker") !== container)
        throw new ConflictException("资料范围与分项不符");
      item.snapshotId = snapshotId;
      item.status = "succeeded";
      await db.query(
        "UPDATE collection_configuration_runs SET details=$3::jsonb WHERE customer_id=$1 AND id=$2",
        [customer, id, JSON.stringify(run)],
      );
      return run;
    });
  }
  async list(customer: string, asset: string) {
    await this.target(this.db, customer, asset);
    const rows = (
      await this.db.query(
        "SELECT id FROM collection_configuration_runs WHERE customer_id=$1 AND asset_id=$2 ORDER BY created_at DESC,id LIMIT 20",
        [customer, asset],
      )
    ).rows;
    return {
      items: await Promise.all(
        rows.map((r) => this.read(customer, String(r.id))),
      ),
    };
  }
}
@Controller("api/customers/:customerId/collections")
export class CollectionConfigurationController {
  constructor(private readonly service: CollectionConfigurationService) {}
  @Get("configurations/:assetId") get(req: AuthorizedRequest) {
    this.ids(req.params.assetId);
    return this.service.get(req.params.customerId, req.params.assetId);
  }
  @Post("configurations/:assetId") save(req: AuthorizedRequest) {
    this.ids(req.params.assetId);
    const v = collectionConfiguration.safeParse(req.body);
    if (!v.success)
      throw new BadRequestException(
        v.error.issues.map((i) => i.message).join("；"),
      );
    return this.service.save(req.params.customerId, req.params.assetId, v.data);
  }
  @Post("configurations/:assetId/run") run(req: AuthorizedRequest) {
    this.ids(req.params.assetId);
    const v = z
      .object({
        idempotencyKey: z.string().min(1).max(100),
        configuration: collectionConfiguration.optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!v.success) throw new BadRequestException("幂等键无效");
    return this.service.run(
      req.params.customerId,
      req.params.assetId,
      v.data.idempotencyKey,
      v.data.configuration,
    );
  }
  @Get("configuration-runs/:runId") read(req: AuthorizedRequest) {
    this.ids(req.params.runId);
    return this.service.read(req.params.customerId, req.params.runId);
  }
  @Get("configurations/:assetId/runs") list(req: AuthorizedRequest) {
    this.ids(req.params.assetId);
    return this.service.list(req.params.customerId, req.params.assetId);
  }
  @Post("configuration-runs/:runId/result") attach(req: AuthorizedRequest) {
    this.ids(req.params.runId);
    const v = z
      .object({
        content: z.enum(["basic", "docker", "software"]),
        snapshotId: z.uuid(),
      })
      .strict()
      .safeParse(req.body);
    if (!v.success) throw new BadRequestException("分项或资料编号无效");
    return this.service.attach(
      req.params.customerId,
      req.params.runId,
      v.data.content,
      v.data.snapshotId,
    );
  }
  private ids(id: string) {
    if (!z.uuid().safeParse(id).success)
      throw new BadRequestException("编号无效");
  }
}
for (const method of ["get", "save", "run", "read", "list", "attach"] as const)
  Req()(CollectionConfigurationController.prototype, method, 0);
Inject(CollectionConfigurationService)(
  CollectionConfigurationController,
  undefined,
  0,
);
