import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Post,
  Req,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Queryable } from "../persistence/database";
import type { AuthorizedRequest, Operator } from "../auth/auth";
import type {
  ReportRevision,
  ReportNarrative,
  ReportDelivery,
  ReportAudit,
} from "../../../../packages/contracts/reports";
import { renderReport, validateNarrative } from "./render";
export class ReportReviewService {
  constructor(private readonly db: Database) {}
  private async load(
    customer: string,
    reportId: string,
    id: string,
    session: Queryable = this.db,
  ): Promise<ReportRevision> {
    const r = await session.query(
      "SELECT result FROM report_revisions WHERE customer_id=$1 AND report_id=$2 AND id=$3",
      [customer, reportId, id],
    );
    if (!r.rows.length) throw new NotFoundException("该客户报告下未找到修订");
    return r.rows[0].result as ReportRevision;
  }
  private async lock(customer: string, reportId: string, s: Queryable) {
    const r = await s.query(
      "SELECT id FROM reports WHERE customer_id=$1 AND id=$2 FOR UPDATE",
      [customer, reportId],
    );
    if (!r.rows.length) throw new NotFoundException("该客户下未找到报告");
  }
  private async latest(
    customer: string,
    reportId: string,
    s: Queryable,
  ): Promise<ReportRevision> {
    const r = await s.query(
      "SELECT result FROM report_revisions WHERE customer_id=$1 AND report_id=$2 ORDER BY number DESC LIMIT 1",
      [customer, reportId],
    );
    return r.rows[0].result as ReportRevision;
  }
  private async audit(
    customer: string,
    reportId: string,
    revisionId: string,
    action: ReportAudit["action"],
    operator: Operator,
    details: Record<string, unknown>,
    s: Queryable,
  ) {
    const actor = {
      name: operator.name,
      operatorId: createHash("sha256").update(operator.token).digest("hex"),
    };
    await s.query(
      "INSERT INTO report_audit(id,customer_id,report_id,revision_id,action,actor,details) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)",
      [
        randomUUID(),
        customer,
        reportId,
        revisionId,
        action,
        JSON.stringify(actor),
        JSON.stringify(details),
      ],
    );
  }
  async revise(
    customer: string,
    reportId: string,
    baseRevisionId: string,
    narrative: unknown,
    operator: Operator,
  ): Promise<ReportRevision> {
    return this.db.transaction(async (s) => {
      await this.lock(customer, reportId, s);
      const base = await this.load(customer, reportId, baseRevisionId, s),
        current = await this.latest(customer, reportId, s);
      if (current.id !== base.id)
        throw new ConflictException("报告已有新修订，请刷新后基于当前修订编辑");
      renderReport(base);
      const checked = validateNarrative(base.facts, narrative);
      const next: ReportRevision = {
        id: randomUUID(),
        reportId,
        customerId: customer,
        number: current.number + 1,
        parentRevisionId: base.id,
        createdAt: new Date().toISOString(),
        createdBy: operator.name,
        status: "draft",
        facts: base.facts,
        factHash: base.factHash,
        narrative: checked,
        templateVersion: base.templateVersion,
      };
      await s.query(
        "INSERT INTO report_revisions(id,customer_id,report_id,number,result) VALUES($1,$2,$3,$4,$5::jsonb)",
        [next.id, customer, reportId, next.number, JSON.stringify(next)],
      );
      await this.audit(
        customer,
        reportId,
        next.id,
        "revise",
        operator,
        { baseRevisionId: base.id, factHash: next.factHash },
        s,
      );
      return next;
    });
  }
  async transition(
    customer: string,
    reportId: string,
    revisionId: string,
    action: "submit_review" | "approve" | "deliver",
    operator: Operator,
  ): Promise<ReportRevision | ReportDelivery> {
    return this.db.transaction(async (s) => {
      await this.lock(customer, reportId, s);
      const revision = await this.load(customer, reportId, revisionId, s);
      if (action === "deliver" && revision.status === "delivered") {
        const old = await s.query(
          "SELECT result FROM report_deliveries WHERE customer_id=$1 AND report_id=$2 AND revision_id=$3",
          [customer, reportId, revisionId],
        );
        if (!old.rows.length)
          throw new ConflictException("交付记录缺失，拒绝重放");
        return { ...(old.rows[0].result as ReportDelivery), replayed: true };
      }
      if ((await this.latest(customer, reportId, s)).id !== revision.id)
        throw new ConflictException("只能流转当前修订，旧交付仍可回读");
      const required = {
        submit_review: "draft",
        approve: "in_review",
        deliver: "approved",
      } as const;
      if (revision.status !== required[action])
        throw new ConflictException(
          "修订状态不允许该操作；需按草稿、提交复核、通过、交付顺序处理",
        );
      renderReport(revision);
      const now = new Date().toISOString();
      revision.status =
        action === "submit_review"
          ? "in_review"
          : action === "approve"
            ? "approved"
            : "delivered";
      if (action === "submit_review") {
        revision.submittedAt = now;
        revision.submittedBy = operator.name;
      }
      if (action === "approve") {
        revision.approvedAt = now;
        revision.approvedBy = operator.name;
      }
      if (action === "deliver") {
        revision.deliveredAt = now;
        revision.deliveredBy = operator.name;
      }
      let delivery: ReportDelivery | undefined;
      if (action === "deliver") {
        const html = renderReport(revision);
        delivery = {
          id: randomUUID(),
          reportId,
          revisionId,
          customerId: customer,
          deliveredAt: now,
          deliveredBy: operator.name,
          factHash: revision.factHash,
          contentHash: createHash("sha256").update(html, "utf8").digest("hex"),
        };
        await s.query(
          "INSERT INTO report_deliveries(id,customer_id,report_id,revision_id,html,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
          [
            delivery.id,
            customer,
            reportId,
            revisionId,
            html,
            JSON.stringify(delivery),
          ],
        );
      }
      await s.query(
        "UPDATE report_revisions SET result=$4::jsonb WHERE customer_id=$1 AND report_id=$2 AND id=$3",
        [customer, reportId, revisionId, JSON.stringify(revision)],
      );
      await this.audit(
        customer,
        reportId,
        revisionId,
        action,
        operator,
        { factHash: revision.factHash, deliveryId: delivery?.id },
        s,
      );
      return delivery ?? revision;
    });
  }
  async export(customer: string, reportId: string, revisionId: string) {
    const revision = await this.load(customer, reportId, revisionId);
    if (revision.status !== "delivered")
      throw new ConflictException("该修订尚未正式交付");
    renderReport(revision);
    const r = await this.db.query(
      "SELECT html,result FROM report_deliveries WHERE customer_id=$1 AND report_id=$2 AND revision_id=$3",
      [customer, reportId, revisionId],
    );
    if (!r.rows.length)
      throw new ConflictException("该修订尚未复核通过并正式交付");
    const html = String(r.rows[0].html),
      delivery = r.rows[0].result as ReportDelivery;
    if (
      delivery.factHash !== revision.factHash ||
      createHash("sha256").update(html, "utf8").digest("hex") !==
        delivery.contentHash
    )
      throw new ConflictException("交付输出校验失败");
    return html;
  }
  async history(customer: string, reportId: string) {
    const found = await this.db.query(
      "SELECT id FROM reports WHERE customer_id=$1 AND id=$2",
      [customer, reportId],
    );
    if (!found.rows.length) throw new NotFoundException("该客户下未找到报告");
    const r = await this.db.query(
      "SELECT result FROM report_revisions WHERE customer_id=$1 AND report_id=$2 ORDER BY number",
      [customer, reportId],
    );
    return { items: r.rows.map((x) => x.result as ReportRevision) };
  }
  async audits(customer: string, reportId: string) {
    await this.history(customer, reportId);
    const r = await this.db.query(
      'SELECT id,revision_id AS "revisionId",action,actor,created_at AS "createdAt",details FROM report_audit WHERE customer_id=$1 AND report_id=$2 ORDER BY sequence',
      [customer, reportId],
    );
    return {
      items: r.rows.map((x) => ({
        ...x,
        createdAt: new Date(x.createdAt as string).toISOString(),
      })),
    };
  }
}
@Controller("api/customers/:customerId/reports/:reportId")
export class ReportReviewController {
  constructor(private readonly service: ReportReviewService) {}
  private valid(req: AuthorizedRequest) {
    if (
      !z.uuid().safeParse(req.params.reportId).success ||
      (req.params.revisionId &&
        !z.uuid().safeParse(req.params.revisionId).success)
    )
      throw new BadRequestException("报告/修订编号无效");
  }
  @Post("revisions") revise(req: AuthorizedRequest) {
    this.valid(req);
    const parsed = z
      .object({ baseRevisionId: z.uuid(), narrative: z.unknown() })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      throw new BadRequestException("只允许受控叙述修订，不接受事实修改");
    return this.service.revise(
      req.params.customerId,
      req.params.reportId,
      parsed.data.baseRevisionId,
      parsed.data.narrative,
      req.operator,
    );
  }
  @Get("revisions") history(req: AuthorizedRequest) {
    this.valid(req);
    return this.service.history(req.params.customerId, req.params.reportId);
  }
  @Get("audit") audits(req: AuthorizedRequest) {
    this.valid(req);
    return this.service.audits(req.params.customerId, req.params.reportId);
  }
  @Post("revisions/:revisionId/submit-review") submit(req: AuthorizedRequest) {
    return this.action(req, "submit_review");
  }
  @Post("revisions/:revisionId/approve") approve(req: AuthorizedRequest) {
    return this.action(req, "approve");
  }
  @Post("revisions/:revisionId/deliver") deliver(req: AuthorizedRequest) {
    return this.action(req, "deliver");
  }
  private action(
    req: AuthorizedRequest,
    action: "submit_review" | "approve" | "deliver",
  ) {
    this.valid(req);
    if (
      !z
        .object({})
        .strict()
        .safeParse(req.body ?? {}).success
    )
      throw new BadRequestException("状态流转不接受事实或叙述");
    return this.service.transition(
      req.params.customerId,
      req.params.reportId,
      req.params.revisionId,
      action,
      req.operator,
    );
  }
  @Get("revisions/:revisionId/export")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header(
    "Content-Disposition",
    'attachment; filename="ys-reviewed-report.html"',
  )
  @Header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'",
  )
  export(req: AuthorizedRequest) {
    this.valid(req);
    return this.service.export(
      req.params.customerId,
      req.params.reportId,
      req.params.revisionId,
    );
  }
}
for (const method of [
  "revise",
  "history",
  "audits",
  "submit",
  "approve",
  "deliver",
  "export",
] as const)
  Req()(ReportReviewController.prototype, method, 0);
Inject(ReportReviewService)(ReportReviewController, undefined, 0);
