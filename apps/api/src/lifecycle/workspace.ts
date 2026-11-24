import {
  addMonths,
  isRisk,
  ruleFor,
  riskLevel,
  localDate,
} from "../lifecycle-risk/calculation";
import { randomUUID } from "node:crypto";
import { sharedSupport } from "./shared-support";
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Req,
  Post,
} from "@nestjs/common";
import { z } from "zod";
import {
  productAliasSchema,
  lifecycleWorkspaceQuery,
  lifecycleApplicability,
  type LifecycleWorkspace,
  type LifecycleWorkspaceItem,
} from "../../../../packages/contracts/lifecycle-workspace";
import {
  defaultRiskConfig,
  type RiskConfig,
  readLifecycleAsset,
} from "../../../../packages/contracts/lifecycle-risk";
import { DATABASE, type Database } from "../persistence/database";
import { categoryExpression } from "../assets/assets.service";
import type { AuthorizedRequest } from "../auth/auth";
export class LifecycleWorkspaceService {
  constructor(private readonly db: Database) {}
  async aliases(customer: string) {
    return {
      items: (
        await this.db.query(
          'SELECT id,category,alias,product,basis,actor,created_at AS "createdAt" FROM lifecycle_product_aliases WHERE customer_id=$1 ORDER BY created_at,id',
          [customer],
        )
      ).rows,
    };
  }
  async addAlias(
    customer: string,
    input: z.infer<typeof productAliasSchema>,
    actor: string,
  ) {
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO lifecycle_product_aliases(id,customer_id,category,alias,product,basis,actor) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        customer,
        input.category,
        input.alias,
        input.product,
        input.basis,
        actor,
      ],
    );
    return { id, ...input, actor };
  }
  async list(
    customer: string,
    query: z.infer<typeof lifecycleWorkspaceQuery>,
  ): Promise<LifecycleWorkspace> {
    const assets = (
      await this.db.query(
        `SELECT id,name,source,attributes,(${categoryExpression}) AS category FROM assets WHERE customer_id=$1 AND deleted_at IS NULL AND (source<>'netbox' OR EXISTS(SELECT 1 FROM netbox_assets n WHERE n.customer_id=assets.customer_id AND n.asset_id=assets.id AND n.active)) ORDER BY name,id`,
        [customer],
      )
    ).rows;
    const configRow = (
      await this.db.query(
        "SELECT config FROM lifecycle_risk_config WHERE customer_id=$1",
        [customer],
      )
    ).rows[0];
    const config = (configRow?.config ?? defaultRiskConfig) as RiskConfig;
    const today = localDate(new Date(), config.timeZone);
    const shared = await sharedSupport(this.db, customer);
    const all: LifecycleWorkspaceItem[] = assets.map((asset) => {
      const { data, issues, hasValues } = readLifecycleAsset(
        (asset.attributes as Record<string, unknown>).lifecycle,
      );
      const applicability = lifecycleApplicability(
        asset.category as LifecycleWorkspaceItem["category"],
      );
      const support = shared
        .forAsset(String(asset.id), asset.attributes)
        .filter((r) =>
          r.kind === "os"
            ? applicability.os
            : ["device", "hardware"].includes(r.kind)
              ? applicability.device
              : true,
        );
      if (applicability.os && !support.some((ref) => ref.kind === "os"))
        support.push({
          kind: "os",
          product: "",
          version: "",
          status: "missing",
          basis: "主机缺少已确认的操作系统产品与版本",
        });
      const riskCategory =
        asset.category === "network"
          ? "network"
          : asset.category === "server"
            ? "server"
            : "unknown";
      for (const ref of support) {
        const type = ref.kind === "os" ? "os_support" : "device_support";
        const { rule } = ruleFor(config, type, riskCategory);
        ref.riskLevel = !rule.enabled
          ? "unassessed"
          : ref.status === "conflict"
            ? "conflict"
            : ref.date
              ? riskLevel(ref.date, today, rule)
              : "missing";
      }
      const dateRisks: LifecycleWorkspaceItem["dateRisks"] = [];
      for (const type of ["warranty", "service_age"] as const) {
        if (
          !(type === "warranty"
            ? applicability.warrantyUntil
            : applicability.purchasedOn)
        )
          continue;
        const dueDate =
          type === "warranty"
            ? (data.warrantyUntil ?? null)
            : data.purchasedOn && config.serviceYears[riskCategory]
              ? addMonths(
                  data.purchasedOn,
                  config.serviceYears[riskCategory]! * 12,
                )
              : null;
        const { rule } = ruleFor(config, type, riskCategory);
        dateRisks.push({
          type,
          dueDate,
          level: !rule.enabled
            ? "unassessed"
            : dueDate
              ? riskLevel(dueDate, today, rule)
              : "missing",
        });
      }
      const resolved = support.some(
        (ref) => ref.status === "matched" && !!ref.date,
      );
      const has = Boolean(
        data.purchasedOn ||
        data.warrantyUntil ||
        data.os ||
        data.device ||
        resolved ||
        hasValues,
      );
      const complete = Boolean(
        (!applicability.purchasedOn || data.purchasedOn) &&
        (!applicability.warrantyUntil || data.warrantyUntil) &&
        resolved &&
        support.every((ref) => ref.status === "matched" && !!ref.date),
      );
      return {
        id: String(asset.id),
        name: String(asset.name),
        source: String(asset.source),
        category: asset.category as LifecycleWorkspaceItem["category"],
        data,
        applicability,
        osIdentity: shared.osIdentity(String(asset.id), asset.attributes),
        state: complete ? "complete" : has ? "partial" : "empty",
        support,
        dateRisks,
        issues,
      };
    });
    const filtered = all.filter(
      (item) =>
        (!query.category || item.category === query.category) &&
        (!query.state || item.state === query.state) &&
        (!query.q || item.name.toLowerCase().includes(query.q.toLowerCase())) &&
        (!query.missing ||
          (["purchasedOn", "warrantyUntil"].includes(query.missing)
            ? item.applicability[
                query.missing as "purchasedOn" | "warrantyUntil"
              ] && !item.data[query.missing as "purchasedOn" | "warrantyUntil"]
            : query.missing === "support"
              ? item.support.some((r) => r.status !== "matched" || !r.date)
              : item.support.some((r) => r.status === query.missing))),
    );
    return {
      items: filtered.slice(query.offset, query.offset + query.limit),
      total: filtered.length,
      limit: query.limit,
      offset: query.offset,
      summary: {
        riskAssets: all.filter(
          (i) =>
            i.support.some(
              (r) =>
                r.kind !== "software" && !!r.riskLevel && isRisk(r.riskLevel),
            ) || i.dateRisks.some((r) => isRisk(r.level)),
        ).length,
        expiredAssets: all.filter(
          (i) =>
            i.support.some(
              (r) => r.kind !== "software" && r.riskLevel === "critical",
            ) || i.dateRisks.some((r) => r.level === "critical"),
        ).length,
        total: all.length,
        empty: all.filter((i) => i.state === "empty").length,
        partial: all.filter((i) => i.state === "partial").length,
        complete: all.filter((i) => i.state === "complete").length,
        unmatched: all.filter((i) =>
          i.support.some((r) => r.status === "unmatched"),
        ).length,
        conflict: all.filter((i) =>
          i.support.some((r) => r.status === "conflict"),
        ).length,
      },
    };
  }
  async history(customer: string, id: string) {
    if (
      !(
        await this.db.query(
          "SELECT id FROM assets WHERE customer_id=$1 AND id=$2",
          [customer, id],
        )
      ).rows.length
    )
      throw new NotFoundException("该客户下未找到资产");
    return {
      items: (
        await this.db.query(
          'SELECT id,actor,status,before_data AS before,after_data AS after,source,created_at AS "createdAt" FROM lifecycle_asset_history WHERE customer_id=$1 AND asset_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100',
          [customer, id],
        )
      ).rows,
    };
  }
}
@Controller("api/customers/:customerId/lifecycle")
export class LifecycleWorkspaceController {
  constructor(private readonly service: LifecycleWorkspaceService) {}
  @Get("aliases") aliases(req: AuthorizedRequest) {
    return this.service.aliases(req.params.customerId);
  }
  @Post("aliases") addAlias(req: AuthorizedRequest) {
    const input = productAliasSchema.safeParse(req.body);
    if (!input.success)
      throw new BadRequestException("需产品别名、分类、标准产品及映射依据");
    return this.service.addAlias(
      req.params.customerId,
      input.data,
      req.operator.name,
    );
  }
  @Get("workspace") list(req: AuthorizedRequest) {
    const q = lifecycleWorkspaceQuery.safeParse(req.query);
    if (!q.success) throw new BadRequestException("生命周期筛选参数无效");
    return this.service.list(req.params.customerId, q.data);
  }
  @Get("assets/:assetId/history") history(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.assetId).success)
      throw new BadRequestException("资产编号无效");
    return this.service.history(req.params.customerId, req.params.assetId);
  }
}
for (const method of ["list", "history", "aliases", "addAlias"] as const)
  Req()(LifecycleWorkspaceController.prototype, method, 0);
Inject(LifecycleWorkspaceService)(LifecycleWorkspaceController, undefined, 0);
