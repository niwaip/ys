import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Module,
  NotFoundException,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DATABASE,
  type Database,
  type Queryable,
} from "../persistence/database";
import {
  LifecycleModule,
  LifecycleService,
} from "../lifecycle/lifecycle.module";
import type { AuthorizedRequest } from "../auth/auth";
import {
  defaultRiskConfig,
  dateSchema,
  supportBindingSchema,
  riskConfigSchema,
  riskTypes,
  treatmentSchema,
  type RiskConfig,
  type RiskItem,
  type RiskView,
  type RiskEvent,
  type Treatment,
} from "../../../../packages/contracts/lifecycle-risk";
import {
  addMonths,
  isRisk,
  localDate,
  ranks,
  riskLevel,
  summarize,
} from "./calculation";
export class LifecycleRiskService {
  constructor(
    private db: Database,
    private lifecycle: LifecycleService,
  ) {}
  async config(customer: string, tx: Queryable = this.db): Promise<RiskConfig> {
    const r = await tx.query(
      "SELECT config FROM lifecycle_risk_config WHERE customer_id=$1",
      [customer],
    );
    return r.rows.length
      ? (r.rows[0].config as RiskConfig)
      : structuredClone(defaultRiskConfig);
  }
  async calculate(
    customer: string,
    config: RiskConfig,
    tx: Queryable,
  ): Promise<RiskView> {
    const now = new Date(),
      today = localDate(now, config.timeZone);
    const assets = await tx.query(
      "SELECT id,name,hardware_type,attributes FROM assets a WHERE customer_id=$1 AND deleted_at IS NULL AND (source<>'netbox' OR EXISTS (SELECT 1 FROM netbox_assets n WHERE n.customer_id=a.customer_id AND n.asset_id=a.id AND n.active)) ORDER BY id",
      [customer],
    );
    const treatments = await tx.query(
      "SELECT asset_id,risk_type,details FROM lifecycle_risk_treatments WHERE customer_id=$1",
      [customer],
    );
    const items: RiskItem[] = [];
    const batches = new Map<
      string,
      Awaited<ReturnType<LifecycleService["getBatch"]>>
    >();
    for (const asset of assets.rows) {
      const raw = (asset.attributes as Record<string, unknown>).lifecycle;
      const value =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const os = supportBindingSchema.safeParse(value.os),
        device = supportBindingSchema.safeParse(value.device),
        purchased = dateSchema.safeParse(value.purchasedOn),
        warranty = dateSchema.safeParse(value.warrantyUntil);
      const data = {
        os: os.success ? os.data : undefined,
        device: device.success ? device.data : undefined,
        purchasedOn: purchased.success ? purchased.data : undefined,
        warrantyUntil: warranty.success ? warranty.data : undefined,
        sourceRef: typeof value.sourceRef === "string" ? value.sourceRef : "",
      };
      const category = asset.hardware_type as RiskItem["category"];
      for (const type of riskTypes) {
        const override =
          config.overrides.find(
            (o) => o.type === type && o.category === category,
          ) ??
          config.overrides.find((o) => o.type === type && o.category === "all");
        const rule = override?.rule ?? config.defaultRule;
        let dueDate: string | null = null,
          basis = "缺少日期或明确的产品支持资料",
          conflict = false;
        const evidence: RiskItem["evidence"] = [];
        const binding =
          type === "os_support"
            ? data?.os
            : type === "device_support"
              ? data?.device
              : undefined;
        if (binding) {
          if (!batches.has(binding.batchId)) {
            try {
              batches.set(
                binding.batchId,
                await this.lifecycle.getBatch(customer, binding.batchId, tx),
              );
            } catch (error) {
              if (!(error instanceof NotFoundException)) throw error;
            }
          }
          const batch = batches.get(binding.batchId);
          const matched = (batch?.rows ?? []).filter(
            (r) =>
              r.product === binding.product &&
              (r.version ?? "") === binding.version &&
              (type !== "os_support" || !!binding.version),
          );
          for (const row of matched) {
            const phase = row[binding.phase];
            evidence.push({
              source: row.source,
              sourceRef: row.sourceRef,
              stage: phase.name,
              rawDate: phase.rawDate,
              batchId: binding.batchId,
              row: row.row,
            });
          }
          const dates = new Set(matched.map((r) => r[binding.phase].date));
          const stages = new Set(matched.map((r) => r[binding.phase].name));
          conflict = dates.size > 1 || stages.size > 1;
          dueDate =
            !conflict && matched.length ? matched[0][binding.phase].date : null;
          basis = matched.length
            ? `${binding.product} ${binding.version} · 明确选择 ${binding.phase.toUpperCase()} 阶段，字面匹配`
            : `${binding.product} ${binding.version} · 无可核实的产品版本及阶段资料，请核对来源`;
        } else if (type === "warranty" && data?.warrantyUntil) {
          dueDate = data.warrantyUntil;
          basis = "资产维保到期日期";
          evidence.push({
            source: "资产资料",
            sourceRef: data.sourceRef,
            stage: "维保到期",
            rawDate: dueDate,
          });
        } else if (
          type === "service_age" &&
          data?.purchasedOn &&
          config.serviceYears[category]
        ) {
          dueDate = addMonths(
            data.purchasedOn,
            config.serviceYears[category]! * 12,
          );
          basis = `购买日期 ${data.purchasedOn} + ${config.serviceYears[category]} 年`;
          evidence.push({
            source: "资产资料",
            sourceRef: data.sourceRef,
            stage: "购买日期",
            rawDate: data.purchasedOn,
          });
        }
        const level = !rule.enabled
          ? "unassessed"
          : conflict
            ? "conflict"
            : dueDate
              ? riskLevel(dueDate, today, rule)
              : "missing";
        const saved = treatments.rows.find(
          (t) => t.asset_id === asset.id && t.risk_type === type,
        )?.details as
          { treatment: Treatment; history: RiskEvent[] } | undefined;
        const treatment = saved
          ? structuredClone(saved.treatment)
          : {
              status: "pending" as const,
              owner: "",
              note: "",
              acceptedUntil: null,
            };
        const history = saved ? structuredClone(saved.history) : [];
        if (
          treatment.status === "accepted" &&
          treatment.acceptedUntil &&
          treatment.acceptedUntil < today &&
          isRisk(level)
        ) {
          treatment.status = "pending";
          history.push({
            ...treatment,
            at: now.toISOString(),
            actor: "系统",
            action: "风险接受到期",
          });
        }
        items.push({
          id: `${asset.id}:${type}`,
          assetId: String(asset.id),
          assetName: String(asset.name),
          category,
          type,
          level,
          dueDate,
          daysRemaining: dueDate
            ? Math.round((Date.parse(dueDate) - Date.parse(today)) / 86400000)
            : null,
          basis,
          rule,
          ruleSource: override ? `${override.category} / ${type}` : "客户默认",
          evidence,
          treatment,
          history,
        });
      }
    }
    items.sort(
      (a, b) =>
        ranks[a.level] - ranks[b.level] ||
        (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") ||
        a.id.localeCompare(b.id),
    );
    return {
      id: randomUUID(),
      customerId: customer,
      calculatedAt: now.toISOString(),
      localDate: today,
      config,
      items,
      summary: summarize(items),
    };
  }
  async persist(tx: Queryable, view: RiskView) {
    for (const i of view.items)
      if (i.history.length)
        await tx.query(
          "INSERT INTO lifecycle_risk_treatments(customer_id,asset_id,risk_type,details) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(customer_id,asset_id,risk_type) DO UPDATE SET details=EXCLUDED.details",
          [
            view.customerId,
            i.assetId,
            i.type,
            JSON.stringify({ treatment: i.treatment, history: i.history }),
          ],
        );
    await tx.query(
      "INSERT INTO lifecycle_risk_views(id,customer_id,result) VALUES($1,$2,$3::jsonb)",
      [view.id, view.customerId, JSON.stringify(view)],
    );
    return view;
  }
  async lock(tx: Queryable, customer: string) {
    await tx.query("SELECT id FROM customers WHERE id=$1 FOR UPDATE", [
      customer,
    ]);
  }
  async current(customer: string) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, customer);
      return this.persist(
        tx,
        await this.calculate(customer, await this.config(customer, tx), tx),
      );
    });
  }
  async preview(customer: string, config: RiskConfig) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, customer);
      const before = await this.calculate(
        customer,
        await this.config(customer, tx),
        tx,
      );
      const after = await this.calculate(customer, config, tx);
      return {
        before: before.summary,
        after,
        changes: after.items.filter((i) => {
          const old = before.items.find((b) => b.id === i.id);
          return old?.level !== i.level || old?.dueDate !== i.dueDate;
        }).length,
      };
    });
  }
  async saveConfig(customer: string, config: RiskConfig) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, customer);
      await tx.query(
        "INSERT INTO lifecycle_risk_config(customer_id,config) VALUES($1,$2::jsonb) ON CONFLICT(customer_id) DO UPDATE SET config=EXCLUDED.config",
        [customer, JSON.stringify(config)],
      );
      return this.persist(tx, await this.calculate(customer, config, tx));
    });
  }
  async treat(
    customer: string,
    assetId: string,
    type: RiskItem["type"],
    treatment: Treatment,
    actor: string,
  ) {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, customer);
      const config = await this.config(customer, tx);
      const view = await this.calculate(customer, config, tx);
      const item = view.items.find(
        (i) => i.assetId === assetId && i.type === type,
      );
      if (!item) throw new NotFoundException("未找到该客户的在管风险对象");
      if (!isRisk(item.level))
        throw new BadRequestException("仅可处理当前命中的风险");
      if (
        treatment.status === "accepted" &&
        treatment.acceptedUntil! < view.localDate
      )
        throw new BadRequestException("接受有效期不能早于当前日期");
      item.treatment = treatment;
      item.history.push({
        ...treatment,
        at: new Date().toISOString(),
        actor,
        action: "更新处理状态",
      });
      view.summary = summarize(view.items);
      return this.persist(tx, view);
    });
  }
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private tick?: Promise<void>;
  onModuleInit() {
    this.timer = setInterval(() => {
      this.tick = this.refreshDaily().catch((error) =>
        console.error("生命周期风险每日更新失败", error),
      );
    }, 60_000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.tick;
  }
  async refreshDaily() {
    if (this.running) return;
    this.running = true;
    try {
      const customers = await this.db.query(
        "SELECT id FROM customers ORDER BY id",
      );
      for (const c of customers.rows) {
        const customer = String(c.id),
          config = await this.config(customer);
        const r = await this.db.query(
          "SELECT result FROM lifecycle_risk_views WHERE customer_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
          [customer],
        );
        const previous = r.rows[0]?.result as RiskView | undefined;
        if (
          !previous ||
          previous.localDate !== localDate(new Date(), config.timeZone)
        )
          await this.current(customer);
      }
    } finally {
      this.running = false;
    }
  }
  async latest(customer: string) {
    const r = await this.db.query(
      "SELECT result FROM lifecycle_risk_views WHERE customer_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
      [customer],
    );
    return r.rows.length
      ? (r.rows[0].result as RiskView)
      : this.current(customer);
  }
  async getView(customer: string, id: string) {
    const r = await this.db.query(
      "SELECT result FROM lifecycle_risk_views WHERE customer_id=$1 AND id=$2",
      [customer, id],
    );
    if (!r.rows.length) throw new NotFoundException("未找到该客户的风险快照");
    return r.rows[0].result as RiskView;
  }
}
@Controller("api/customers/:customerId/lifecycle-risk")
class RiskController {
  constructor(private service: LifecycleRiskService) {}
  @Get("config") config(req: AuthorizedRequest) {
    return this.service.config(req.params.customerId);
  }
  private parseConfig(body: unknown) {
    const p = riskConfigSchema.safeParse(body);
    if (!p.success)
      throw new BadRequestException(
        p.error.issues.map((i) => i.message).join("；"),
      );
    return p.data;
  }
  @Post("preview") preview(req: AuthorizedRequest) {
    return this.service.preview(
      req.params.customerId,
      this.parseConfig(req.body),
    );
  }
  @Put("config") save(req: AuthorizedRequest) {
    return this.service.saveConfig(
      req.params.customerId,
      this.parseConfig(req.body),
    );
  }
  @Put("treatments/:assetId/:type") treat(req: AuthorizedRequest) {
    const id = z.uuid().safeParse(req.params.assetId),
      type = z.enum(riskTypes).safeParse(req.params.type),
      input = treatmentSchema.safeParse(req.body);
    if (!id.success || !type.success || !input.success)
      throw new BadRequestException("风险处理资料无效，接受风险需原因和有效期");
    return this.service.treat(
      req.params.customerId,
      id.data,
      type.data,
      input.data,
      req.operator.name,
    );
  }
  @Get("latest") latest(req: AuthorizedRequest) {
    return this.service.latest(req.params.customerId);
  }
  @Get("current") current(req: AuthorizedRequest) {
    return this.service.current(req.params.customerId);
  }
  @Get("views/:id") view(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.id).success)
      throw new BadRequestException("编号无效");
    return this.service.getView(req.params.customerId, req.params.id);
  }
}
for (const method of [
  "config",
  "current",
  "view",
  "preview",
  "save",
  "treat",
  "latest",
] as const)
  Req()(RiskController.prototype, method, 0);
Inject(LifecycleRiskService)(RiskController, undefined, 0);
@Module({
  imports: [LifecycleModule],
  controllers: [RiskController],
  providers: [
    {
      provide: LifecycleRiskService,
      inject: [DATABASE, LifecycleService],
      useFactory: (db: Database, lifecycle: LifecycleService) =>
        new LifecycleRiskService(db, lifecycle),
    },
  ],
  exports: [LifecycleRiskService],
})
export class LifecycleRiskModule {}
