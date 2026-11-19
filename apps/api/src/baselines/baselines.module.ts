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
import {
  CollectionsModule,
  CollectionsService,
} from "../collections/collections.module";
import { NetBoxService, NetBoxPrewriteError } from "../netbox/netbox.module";
import {
  collectionSectionNames,
  type HostCollection,
} from "../../../../packages/contracts/collections";
import { compare, adopt, type Values } from "./comparison";
const names = ["identity", ...collectionSectionNames] as const;
const confirmation = z
  .object({
    snapshotId: z.uuid(),
    expectedBaselineId: z.uuid().nullable(),
    idempotencyKey: z.string().min(1).max(100),
    sections: z.array(z.enum(names)).min(1).max(9),
    excludeFields: z
      .array(
        z
          .string()
          .regex(
            /^(identity|os|hardware|dockerClient|dockerDaemon)\.[a-zA-Z][a-zA-Z0-9_]*$/,
          ),
      )
      .max(100)
      .default([]),
  })
  .strict();
type Approval = {
  id: string;
  customer_id: string;
  asset_id: string;
  status: string;
  plan: {
    values: Values;
    sources: Values;
    netbox: { name?: string; serial?: string } | null;
    expected: string | null;
    remoteExpected?: { name?: string; serial?: string };
  };
  snapshot_id: string;
  actor: string;
  created_at: string;
};
export class BaselinesService {
  constructor(
    private db: Database,
    private collections: CollectionsService,
    private netbox: NetBoxService,
  ) {}
  async onModuleInit() {
    await this.db.query(
      "UPDATE asset_baselines SET status='unknown' WHERE status='pending'",
    );
  }
  private async asset(customer: string, id: string) {
    const r = (
      await this.db.query(
        "SELECT * FROM assets WHERE customer_id=$1 AND id=$2",
        [customer, id],
      )
    ).rows[0];
    if (!r) throw new NotFoundException("该客户下未找到资产");
    return r;
  }
  private async current(customer: string, asset: string) {
    return (
      await this.db.query(
        "SELECT * FROM asset_baselines WHERE customer_id=$1 AND asset_id=$2 AND status='confirmed' ORDER BY sequence DESC LIMIT 1",
        [customer, asset],
      )
    ).rows[0] as Approval | undefined;
  }
  private async snapshot(customer: string, asset: string, id?: string) {
    if (id) {
      const r = await this.collections.row(customer, id);
      if (r.asset_id !== asset)
        throw new ConflictException("快照不属于当前主机");
      return r;
    }
    return (
      await this.db.query(
        "SELECT * FROM collection_snapshots WHERE customer_id=$1 AND asset_id=$2 ORDER BY created_at DESC,id LIMIT 1",
        [customer, asset],
      )
    ).rows[0];
  }
  async preview(customer: string, asset: string, id?: string) {
    const target = await this.asset(customer, asset),
      current = await this.current(customer, asset),
      row = await this.snapshot(customer, asset, id),
      data = row?.normalized as HostCollection | undefined;
    const sections: Values = {};
    for (const name of names) {
      const section =
        name === "identity"
          ? data
            ? { status: "acquired", data: data.identity, issues: [] }
            : undefined
          : data?.sections[name];
      const comparable = section?.status === "acquired";
      const changes = comparable
        ? compare(name, current?.plan.values[name], section.data)
        : [];
      sections[name] = {
        status: section?.status ?? "not_collected",
        comparable,
        issues: section?.issues ?? [],
        counts: {
          added: changes.filter((c) => c.kind === "added").length,
          removed: changes.filter((c) => c.kind === "removed").length,
          changed: changes.filter((c) => c.kind === "changed").length,
        },
        changes: changes.slice(0, 100),
        totalChanges: changes.length,
        baselineSource: current?.plan.sources[name] ?? null,
      };
    }
    const history = (
      await this.db.query(
        'SELECT id,status,actor,created_at AS "createdAt",snapshot_id AS "snapshotId" FROM asset_baselines WHERE customer_id=$1 AND asset_id=$2 ORDER BY sequence DESC LIMIT 20',
        [customer, asset],
      )
    ).rows;
    return {
      asset: { id: asset, name: target.name, attributes: target.attributes },
      netboxConfigured: this.netbox.enabled,
      current: current
        ? {
            id: current.id,
            actor: current.actor,
            createdAt: current.created_at,
            sources: current.plan.sources,
          }
        : null,
      snapshot: row
        ? await this.collections.get(customer, String(row.id))
        : null,
      sections,
      history,
    };
  }
  async section(
    customer: string,
    asset: string,
    name: string,
    query: {
      snapshotId?: string;
      view: string;
      offset: number;
      q: string;
      changesOnly: boolean;
    },
  ) {
    await this.asset(customer, asset);
    const current = await this.current(customer, asset),
      row = await this.snapshot(customer, asset, query.snapshotId),
      data = row?.normalized as HostCollection | undefined;
    const value =
      query.view === "baseline"
        ? current?.plan.values[name]
        : name === "identity"
          ? data?.identity
          : data?.sections[name as keyof HostCollection["sections"]]?.data;
    const full = value ?? null;
    let items = Array.isArray(full) ? full : [];
    let changes: ReturnType<typeof compare> = [];
    const complete =
      name === "identity" ||
      data?.sections[name as keyof HostCollection["sections"]]?.status ===
        "acquired";
    if (complete)
      changes = compare(
        name,
        current?.plan.values[name],
        name === "identity"
          ? data?.identity
          : data?.sections[name as keyof HostCollection["sections"]]?.data,
      );
    if (query.changesOnly) items = changes;
    if (query.q)
      items = items.filter((v) =>
        JSON.stringify(v).toLowerCase().includes(query.q.toLowerCase()),
      );
    return {
      data: Array.isArray(full) ? null : full,
      items: items.slice(query.offset, query.offset + 50),
      total: items.length,
      offset: query.offset,
      changes: changes.slice(0, 100),
    };
  }
  async confirm(
    customer: string,
    asset: string,
    input: z.infer<typeof confirmation>,
    actor: string,
  ) {
    await this.asset(customer, asset);
    const hash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const replay = (
      await this.db.query(
        "SELECT * FROM asset_baselines WHERE customer_id=$1 AND idempotency_key=$2",
        [customer, input.idempotencyKey],
      )
    ).rows[0];
    if (replay) {
      if (replay.input_hash !== hash || replay.asset_id !== asset)
        throw new ConflictException("幂等键对应不同确认内容");
      return this.result(replay as Approval);
    }
    await this.collections.assertTarget(customer, asset);
    const snapshot = await this.snapshot(customer, asset, input.snapshotId);
    const data = snapshot.normalized as HostCollection;
    const approval = await this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM customers WHERE id=$1 FOR UPDATE", [
        customer,
      ]);
      const repeated = (
        await tx.query(
          "SELECT * FROM asset_baselines WHERE customer_id=$1 AND idempotency_key=$2",
          [customer, input.idempotencyKey],
        )
      ).rows[0];
      if (repeated) {
        if (repeated.input_hash !== hash || repeated.asset_id !== asset)
          throw new ConflictException("幂等键对应不同确认内容");
        return { ...repeated, replayed: true } as Approval & { replayed: true };
      }
      await tx.query(
        "SELECT id FROM assets WHERE customer_id=$1 AND id=$2 FOR UPDATE",
        [customer, asset],
      );
      const old = (
        await tx.query(
          "SELECT * FROM asset_baselines WHERE customer_id=$1 AND asset_id=$2 AND status='confirmed' ORDER BY sequence DESC LIMIT 1",
          [customer, asset],
        )
      ).rows[0] as Approval | undefined;
      if ((old?.id ?? null) !== input.expectedBaselineId)
        throw new ConflictException("基线已变化，请刷新差异后确认");
      if (
        (
          await tx.query(
            "SELECT id FROM asset_baselines WHERE customer_id=$1 AND asset_id=$2 AND status IN ('pending','unknown')",
            [customer, asset],
          )
        ).rows.length
      )
        throw new ConflictException("已有待核对的写回，请先核对完成");
      const values: Values = structuredClone(old?.plan.values ?? {}),
        sources: Values = structuredClone(old?.plan.sources ?? {});
      for (const name of new Set(input.sections)) {
        const section =
          name === "identity"
            ? { status: "acquired", data: data.identity }
            : data.sections[name];
        if (section?.status !== "acquired")
          throw new BadRequestException(
            "只能采纳完整取得的区块，缺失或部分资料请补采",
          );
        const next = structuredClone(section.data) as Values;
        for (const path of input.excludeFields) {
          const [prefix, key] = path.split(".");
          if (
            prefix === name &&
            next &&
            typeof next === "object" &&
            !Array.isArray(next)
          )
            delete next[key];
        }
        compare(name, values[name], next);
        const adopted = adopt(
          name,
          values[name],
          next,
          sources[name],
          input.snapshotId,
        );
        values[name] = adopted.value;
        sources[name] = adopted.sources;
      }
      const acceptedIdentity = input.sections.includes("identity")
        ? data.identity
        : null;
      const patch = {
        ...(acceptedIdentity &&
        !input.excludeFields.includes("identity.hostname")
          ? { name: acceptedIdentity.hostname }
          : {}),
        ...(acceptedIdentity?.serial &&
        !input.excludeFields.includes("identity.serial")
          ? { serial: acceptedIdentity.serial }
          : {}),
      };
      const netbox =
        this.netbox.enabled && Object.keys(patch).length ? patch : null;
      if (
        (netbox?.name?.length ?? 0) > 200 ||
        (netbox?.serial?.length ?? 0) > 200
      )
        throw new BadRequestException("NetBox主机名称/序列号超出字段范围");
      const target = snapshot.target as { name: string; attributes: Values };
      const remoteExpected = {
        ...(patch.name ? { name: target.name } : {}),
        ...(patch.serial
          ? { serial: String(target.attributes.serial ?? "") }
          : {}),
      };
      const id = randomUUID(),
        plan = {
          values,
          sources,
          netbox,
          remoteExpected,
          expected: input.expectedBaselineId,
          selection: {
            sections: input.sections,
            excludeFields: input.excludeFields,
          },
        };
      await tx.query(
        "INSERT INTO asset_baselines(id,customer_id,asset_id,snapshot_id,actor,idempotency_key,input_hash,status,plan) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8::jsonb)",
        [
          id,
          customer,
          asset,
          input.snapshotId,
          actor,
          input.idempotencyKey,
          hash,
          JSON.stringify(plan),
        ],
      );
      return {
        id,
        customer_id: customer,
        asset_id: asset,
        snapshot_id: input.snapshotId,
        actor,
        status: "pending",
        created_at: new Date().toISOString(),
        plan,
      } as Approval;
    });
    if ("replayed" in approval) return this.result(approval);
    try {
      if (approval.plan.netbox)
        await this.netbox.updateBaseline(
          customer,
          asset,
          approval.plan.netbox,
          `baseline:${approval.id}`,
          approval.plan.remoteExpected ?? {},
        );
    } catch (error) {
      if (error instanceof NetBoxPrewriteError) {
        await this.db.query(
          "UPDATE asset_baselines SET status='rejected' WHERE id=$1 AND status='pending'",
          [approval.id],
        );
        return {
          ...this.result(approval),
          status: "rejected",
          message: error.message,
        };
      }
      await this.db.query(
        "UPDATE asset_baselines SET status='unknown' WHERE id=$1 AND status='pending'",
        [approval.id],
      );
      return {
        ...this.result(approval),
        status: "unknown",
        message: "NetBox写回未获确认，基线尚未更新；请核对远端后再确认状态",
      };
    }
    return this.finalize(approval);
  }
  private result(row: Approval) {
    return {
      id: row.id,
      status: row.status,
      snapshotId: row.snapshot_id,
      actor: row.actor,
      createdAt: row.created_at,
      netbox: row.plan.netbox,
    };
  }
  private async finalize(row: Approval) {
    const saved = await this.db.query(
      "UPDATE asset_baselines SET status='confirmed' WHERE id=$1 AND status=$2 RETURNING id",
      [row.id, row.status],
    );
    if (!saved.rows.length)
      throw new ConflictException("确认状态已变化，请刷新");
    return { ...this.result(row), status: "confirmed" };
  }
  async cancel(customer: string, asset: string, id: string) {
    await this.asset(customer, asset);
    const r = await this.db.query(
      "UPDATE asset_baselines SET status='cancelled' WHERE customer_id=$1 AND asset_id=$2 AND id=$3 AND status='unknown' RETURNING id",
      [customer, asset, id],
    );
    if (!r.rows.length)
      throw new ConflictException("只有待核对记录可以放弃采纳");
    return { id, status: "cancelled" };
  }
  async reconcile(customer: string, asset: string, id: string) {
    await this.asset(customer, asset);
    const row = (
      await this.db.query(
        "SELECT * FROM asset_baselines WHERE customer_id=$1 AND asset_id=$2 AND id=$3",
        [customer, asset, id],
      )
    ).rows[0] as Approval | undefined;
    if (!row) throw new NotFoundException("未找到确认记录");
    if (row.status === "confirmed") return this.result(row);
    if (row.status !== "unknown")
      throw new ConflictException("该记录已放弃采纳");
    if (row.plan.netbox)
      await this.netbox.verifyBaseline(customer, asset, row.plan.netbox);
    return this.finalize(row);
  }
}
@Controller("api/customers/:customerId/assets/:assetId/baseline")
class BaselinesController {
  constructor(private service: BaselinesService) {}
  private ids(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.assetId).success)
      throw new BadRequestException("资产编号无效");
    return [req.params.customerId, req.params.assetId] as const;
  }
  @Get() preview(req: AuthorizedRequest) {
    const q = z
      .object({ snapshotId: z.uuid().optional() })
      .strict()
      .safeParse(req.query);
    if (!q.success) throw new BadRequestException("快照编号无效");
    return this.service.preview(...this.ids(req), q.data.snapshotId);
  }
  @Get("sections/:section") section(req: AuthorizedRequest) {
    const q = z
      .object({
        snapshotId: z.uuid().optional(),
        view: z.enum(["observed", "baseline"]).default("observed"),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
        q: z.string().max(200).default(""),
        changesOnly: z.enum(["true", "false"]).default("false"),
      })
      .strict()
      .safeParse(req.query);
    if (
      !q.success ||
      !names.includes(req.params.section as (typeof names)[number])
    )
      throw new BadRequestException("资料分项或分页无效");
    return this.service.section(...this.ids(req), req.params.section, {
      ...q.data,
      changesOnly: q.data.changesOnly === "true",
    });
  }
  @Post("confirm") confirm(req: AuthorizedRequest) {
    const p = confirmation.safeParse(req.body);
    if (!p.success)
      throw new BadRequestException("确认范围、基线版本或快照无效");
    return this.service.confirm(...this.ids(req), p.data, req.operator.name);
  }
  @Post(":approvalId/cancel") cancel(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.approvalId).success)
      throw new BadRequestException("确认编号无效");
    return this.service.cancel(...this.ids(req), req.params.approvalId);
  }
  @Post(":approvalId/reconcile") reconcile(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.approvalId).success)
      throw new BadRequestException("确认编号无效");
    return this.service.reconcile(...this.ids(req), req.params.approvalId);
  }
}
for (const m of [
  "preview",
  "section",
  "confirm",
  "reconcile",
  "cancel",
] as const)
  Req()(BaselinesController.prototype, m, 0);
Inject(BaselinesService)(BaselinesController, undefined, 0);
@Module({
  imports: [CollectionsModule],
  controllers: [BaselinesController],
  providers: [
    {
      provide: BaselinesService,
      inject: [DATABASE, CollectionsService, NetBoxService],
      useFactory: (db: Database, c: CollectionsService, n: NetBoxService) =>
        new BaselinesService(db, c, n),
    },
  ],
})
export class BaselinesModule {}
