import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  reportTaskInput,
  type ReportTask,
  type ReportHost,
} from "../../../../packages/contracts/report-center";
import type { AuthorizedRequest, Operator } from "../auth/auth";
import type { Database } from "../persistence/database";
import { hashJson } from "../persistence/hash-json";
import { categoryExpression } from "../assets/assets.service";
import type { ReportsService } from "./reports.module";

export class ReportCenterService {
  constructor(
    private readonly db: Database,
    private readonly reports: ReportsService,
  ) {}
  async create(customer: string, operator: Operator, value: unknown) {
    const parsed = reportTaskInput.safeParse(value);
    if (!parsed.success)
      throw new BadRequestException("请选择明确服务器范围和报告配置");
    const input = parsed.data,
      inputHash = hashJson(input);
    const previous = (
      await this.db.query(
        "SELECT details,input_hash FROM report_tasks WHERE customer_id=$1 AND idempotency_key=$2",
        [customer, input.idempotencyKey],
      )
    ).rows[0];
    if (previous) {
      if (previous.input_hash !== inputHash)
        throw new ConflictException("幂等键已用于其他报告配置");
      return previous.details as ReportTask;
    }
    const hosts: ReportHost[] = [];
    for (const id of input.scope.assetIds) {
      const asset = (
        await this.db.query(
          `SELECT id,name,attributes,(${categoryExpression}) AS category FROM assets WHERE customer_id=$1 AND id=$2 AND deleted_at IS NULL`,
          [customer, id],
        )
      ).rows[0];
      if (!asset) throw new NotFoundException("该客户下未找到在管服务器");
      if (asset.category !== "server" && asset.category !== "vm")
        throw new ConflictException(
          "首期报告范围仅支持物理服务器和虚拟机，请先确认资产分类",
        );
      const baseline = (
        await this.db.query(
          "SELECT snapshot_id FROM asset_baselines WHERE customer_id=$1 AND asset_id=$2 AND status='confirmed' ORDER BY sequence DESC LIMIT 1",
          [customer, id],
        )
      ).rows[0];
      const snapshotId = baseline ? String(baseline.snapshot_id) : null;
      const assessment = snapshotId
        ? (
            await this.db.query(
              "SELECT id FROM vulnerability_jobs WHERE customer_id=$1 AND target_object_id=$2 AND target_input_id=$3 AND status='succeeded' ORDER BY created_at DESC,id DESC LIMIT 1",
              [customer, id, snapshotId],
            )
          ).rows[0]
        : undefined;
      hosts.push({
        assetId: id,
        name: String(asset.name),
        attributes: asset.attributes as Record<string, unknown>,
        snapshotId,
        assessmentRefs: assessment ? [String(assessment.id)] : [],
        lifecycleRefs: [],
        status: assessment ? "available" : "unassessed",
        issues: assessment
          ? []
          : ["未取得当前已确认资料对应的可用评估结果，不代表零风险"],
      });
    }
    const task: ReportTask = {
      id: randomUUID(),
      customerId: customer,
      name: input.name,
      createdAt: new Date().toISOString(),
      createdBy: operator.name,
      status: "queued",
      hosts,
      input,
    };
    const saved = await this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        "INSERT INTO report_tasks(id,customer_id,idempotency_key,input_hash,actor_key,status,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(customer_id,idempotency_key) DO NOTHING RETURNING details",
        [
          task.id,
          customer,
          input.idempotencyKey,
          inputHash,
          createHash("sha256").update(operator.token).digest("hex"),
          task.status,
          JSON.stringify(task),
        ],
      );
      if (inserted.rows.length) return task;
      const old = (
        await tx.query(
          "SELECT details,input_hash FROM report_tasks WHERE customer_id=$1 AND idempotency_key=$2",
          [customer, input.idempotencyKey],
        )
      ).rows[0];
      if (old.input_hash !== inputHash)
        throw new ConflictException("幂等键已用于其他报告配置");
      return old.details as ReportTask;
    });
    if (saved.id !== task.id) return saved;
    const report = await this.reports.create(
      customer,
      operator.name,
      {
        assessmentRefs: hosts.flatMap((h) => h.assessmentRefs),
        lifecycleRefs: [],
      },
      { name: task.name, taskId: task.id, hosts, checkedAt: task.createdAt },
    );
    task.reportId = report.id;
    task.status = "completed";
    await this.db.query(
      "UPDATE report_tasks SET status=$3,details=$4::jsonb WHERE customer_id=$1 AND id=$2",
      [customer, task.id, task.status, JSON.stringify(task)],
    );
    return task;
  }
  async get(customer: string, id: string) {
    if (!z.uuid().safeParse(id).success)
      throw new BadRequestException("报告任务编号无效");
    const row = (
      await this.db.query(
        "SELECT details FROM report_tasks WHERE customer_id=$1 AND id=$2",
        [customer, id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("该客户下未找到报告任务");
    return row.details as ReportTask;
  }
  async list(customer: string) {
    return {
      items: (
        await this.db.query(
          "SELECT details FROM report_tasks WHERE customer_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100",
          [customer],
        )
      ).rows.map((r) => r.details as ReportTask),
    };
  }
}
@Controller("api/customers/:customerId/report-center")
export class ReportCenterController {
  constructor(private readonly service: ReportCenterService) {}
  @Post("tasks") @HttpCode(202) create(req: AuthorizedRequest) {
    return this.service.create(req.params.customerId, req.operator, req.body);
  }
  @Get("tasks") list(req: AuthorizedRequest) {
    return this.service.list(req.params.customerId);
  }
  @Get("tasks/:taskId") get(req: AuthorizedRequest) {
    return this.service.get(req.params.customerId, req.params.taskId);
  }
}
for (const method of ["create", "list", "get"] as const)
  Req()(ReportCenterController.prototype, method, 0);
Inject(ReportCenterService)(ReportCenterController, undefined, 0);
