import { ConflictException, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { ReportTask } from "../../../../packages/contracts/report-center";
import type { Database } from "../persistence/database";
import type { Operator } from "../auth/auth";
import type { AssessmentService } from "../assessments/assessments.module";
import type { WindowsAssessmentService } from "../windows-assessments/windows-assessments.module";
import type { ReportsService } from "./reports.module";
import { requireActiveAsset } from "../assets/asset-state";

export class ReportTaskRunner {
  private active = new Map<string, Promise<void>>();
  private stopping = false;
  constructor(
    private db: Database,
    private assessments: AssessmentService,
    private windows: WindowsAssessmentService,
    private reports: ReportsService,
    private operators: Operator[],
  ) {}

  async onModuleInit() {
    // Explicit retry is required: restarting must never replay external work.
    await this.db
      .query(`UPDATE report_tasks SET status='interrupted',details=jsonb_set(details,'{status}','"interrupted"'::jsonb)
      WHERE status IN ('queued','running')`);
  }
  async onModuleDestroy() {
    this.stopping = true;
    await Promise.allSettled(this.active.values());
  }
  async load(customer: string, id: string): Promise<ReportTask> {
    const r = await this.db.query(
      "SELECT details FROM report_tasks WHERE customer_id=$1 AND id=$2",
      [customer, id],
    );
    if (!r.rows.length) throw new NotFoundException("该客户下未找到报告任务");
    return r.rows[0].details as ReportTask;
  }
  plan(task: ReportTask) {
    const incremental = task.input.mode === "incremental";
    task.items = task.hosts.map((host) => ({
      id: randomUUID(),
      name: host.name,
      kind: "linux",
      objectId: host.assetId,
      hostIds: [host.assetId],
      snapshotId: host.snapshotId,
      attempt: 0,
      ...(incremental &&
      host.assessmentRefs.length &&
      host.freshness.assessment === "fresh"
        ? { status: "reused" as const, assessmentId: host.assessmentRefs[0] }
        : { status: "pending" as const }),
    }));
    for (const object of task.frozenScope?.objects ?? [])
      task.items.push({
        id: randomUUID(),
        name: object.name,
        kind: object.kind,
        objectId: object.objectId,
        hostIds: object.hostIds,
        snapshotId: object.versionId,
        attempt: 0,
        status: "pending",
      });
  }
  async save(task: ReportTask) {
    await this.db.query(
      "UPDATE report_tasks SET status=$3,details=$4::jsonb WHERE customer_id=$1 AND id=$2 AND details->>'reportId' IS NULL AND (status<>'cancelled' OR $3='cancelled')",
      [task.customerId, task.id, task.status, JSON.stringify(task)],
    );
  }
  start(customer: string, id: string) {
    if (this.stopping || this.active.has(id)) return;
    const work = this.work(customer, id)
      .catch(async (error) => {
        const task = await this.load(customer, id);
        if (!task.reportId && task.status !== "cancelled") {
          task.status = this.stopping ? "interrupted" : "failed";
          task.error = (error as Error).message;
          await this.save(task);
        }
      })
      .finally(() => this.active.delete(id));
    this.active.set(id, work);
  }
  private async authorized(task: ReportTask) {
    const row = (
      await this.db.query(
        "SELECT actor_key FROM report_tasks WHERE customer_id=$1 AND id=$2",
        [task.customerId, task.id],
      )
    ).rows[0];
    if (
      !this.operators.some(
        (operator) =>
          operator.customerIds.includes(task.customerId) &&
          createHash("sha256").update(operator.token).digest("hex") ===
            row?.actor_key,
      )
    )
      throw new ConflictException("创建任务的操作员已无当前客户权限，停止派发");
  }
  private async work(customer: string, id: string) {
    let task = await this.load(customer, id);
    if (task.reportId || !["queued"].includes(task.status)) return;
    task.status = "running";
    await this.save(task);
    for (const planned of task.items ?? []) {
      if (this.stopping) break;
      task = await this.load(customer, id);
      if (task.status === "cancelled") return;
      const item = task.items!.find((x) => x.id === planned.id)!;
      if (item.status !== "pending") continue;
      item.status = "running";
      await this.save(task);
      try {
        await this.authorized(task);
        await this.db.transaction(async (tx) => {
          for (const host of item.hostIds)
            await requireActiveAsset(tx, customer, host);
        });
        if (!item.snapshotId) {
          item.status = "unsupported";
          item.error = "缺少可用于评估的已确认完整资料；请先采集并确认";
        } else {
          const key = `report:${task.id}:${item.id}:${item.attempt}`;
          let job: { id: string };
          if (item.kind === "linux") {
            const win = await this.db.query(
              "SELECT id FROM windows_snapshots WHERE customer_id=$1 AND id=$2 AND asset_id=$3",
              [customer, item.snapshotId, item.objectId],
            );
            if (win.rows.length) item.kind = "windows";
          }
          if (item.kind === "windows") {
            if (!task.input.windowsRuleImportId)
              throw new ConflictException(
                "Windows 需明确选择已接入的离线规则批次；不能声称完整补丁覆盖",
              );
            const submitted = await this.windows.submit(customer, {
              snapshotId: item.snapshotId,
              ruleImportId: task.input.windowsRuleImportId,
              idempotencyKey: key,
            });
            job = submitted as { id: string };
          } else if (item.kind === "linux") {
            job = await this.assessments.submit(customer, {
              assetId: item.objectId,
              snapshotId: item.snapshotId,
              idempotencyKey: key,
            });
          } else {
            job = await this.assessments.submit(
              customer,
              item.kind === "software"
                ? {
                    softwareId: item.objectId,
                    versionId: item.snapshotId,
                    idempotencyKey: key,
                  }
                : {
                    containerId: item.objectId,
                    versionId: item.snapshotId,
                    idempotencyKey: key,
                  },
            );
          }
          item.assessmentId = job.id;
          await this.save(task);
          while (!this.stopping) {
            const current = await this.load(customer, id);
            if (current.status === "cancelled") return;
            const result = await this.assessments.get(customer, job.id, {
              includeRawReport: false,
            });
            if (!["queued", "running"].includes(result.status)) {
              item.status =
                result.status === "succeeded"
                  ? "succeeded"
                  : result.status === "interrupted"
                    ? "interrupted"
                    : "failed";
              item.error = result.error;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (this.stopping) item.status = "interrupted";
        }
      } catch (error) {
        item.status = "failed";
        item.error = (error as Error).message;
      }
      // Cancellation wins over a late result, retaining the bound assessment reference.
      const current = await this.load(customer, id);
      if (current.status === "cancelled") return;
      await this.save(task);
    }
    task = await this.load(customer, id);
    if (task.status === "cancelled") return;
    if (this.stopping) task.status = "interrupted";
    else if (
      task.items?.some((item) =>
        ["failed", "interrupted"].includes(item.status),
      )
    )
      task.status = "needs_attention";
    else {
      await this.finalize(task);
      return;
    }
    await this.save(task);
  }
  async retry(customer: string, id: string, itemIds: string[]) {
    const task = await this.load(customer, id);
    if (
      task.reportId ||
      this.active.has(id) ||
      !["needs_attention", "interrupted", "failed"].includes(task.status)
    )
      throw new ConflictException("当前任务不能重试");
    const selected =
      task.items?.filter((item) => itemIds.includes(item.id)) ?? [];
    if (
      selected.length !== itemIds.length ||
      selected.some(
        (item) =>
          !["failed", "interrupted", "running", "pending"].includes(
            item.status,
          ),
      )
    )
      throw new ConflictException("只能重试本任务失败或中断的分项");
    for (const item of selected) {
      item.previousAssessmentIds = [
        ...(item.previousAssessmentIds ?? []),
        ...(item.assessmentId ? [item.assessmentId] : []),
      ];
      delete item.assessmentId;
      delete item.error;
      item.attempt++;
      item.status = "pending";
    }
    task.status = "queued";
    await this.save(task);
    this.start(customer, id);
    return task;
  }
  async cancel(customer: string, id: string) {
    const task = await this.load(customer, id);
    if (task.reportId) throw new ConflictException("已固定报告不能取消");
    task.status = "cancelled";
    task.cancelledAt ??= new Date().toISOString();
    for (const item of task.items ?? [])
      if (["pending", "running"].includes(item.status))
        item.status = "cancelled";
    await this.save(task);
    return task;
  }
  async finish(customer: string, id: string) {
    const task = await this.load(customer, id);
    if (
      this.active.has(id) ||
      !["needs_attention", "cancelled", "interrupted", "failed"].includes(
        task.status,
      )
    )
      throw new ConflictException("请等待执行结束或取消后再生成覆盖报告");
    await this.finalize(task);
    return task;
  }
  private async finalize(task: ReportTask) {
    const center = task.frozenScope!;
    for (const host of center.hosts) {
      host.issues = host.issues.filter(
        (issue) =>
          !issue.startsWith("未取得当前已确认资料对应") &&
          !issue.startsWith("最近评估 "),
      );

      const items = (task.items ?? []).filter((item) =>
        item.hostIds.includes(host.assetId),
      );
      host.assessmentRefs = items.flatMap((item) =>
        item.assessmentId ? [item.assessmentId] : [],
      );
      host.status =
        items.some((item) => ["succeeded", "reused"].includes(item.status)) ||
        host.lifecycleRefs.length
          ? "available"
          : "unassessed";
      host.issues.push(
        ...items
          .filter((item) => !["succeeded", "reused"].includes(item.status))
          .map(
            (item) =>
              `${item.name}：${item.status}；${item.error ?? "无可用结果，不代表零风险"}`,
          ),
      );
      const own = items.find((item) => item.objectId === host.assetId);
      if (own?.assessmentId) {
        const assessment = await this.assessments.get(
          task.customerId,
          own.assessmentId,
          { includeRawReport: false },
        );
        host.assessedAt = assessment.finishedAt ?? null;
        host.freshness.assessment =
          assessment.status === "succeeded" ? "fresh" : "missing";
      }
    }
    for (const object of center.objects ?? []) {
      const item = task.items?.find(
        (item) =>
          item.objectId === object.objectId &&
          item.snapshotId === object.versionId,
      );
      object.assessmentId = item?.assessmentId ?? null;
      object.status =
        item && ["succeeded", "reused"].includes(item.status)
          ? "available"
          : "unassessed";
    }
    const report = await this.reports.create(
      task.customerId,
      task.createdBy,
      {
        assessmentRefs: [
          ...new Set(center.hosts.flatMap((host) => host.assessmentRefs)),
        ],
        lifecycleRefs: [
          ...new Set(center.hosts.flatMap((host) => host.lifecycleRefs)),
        ],
      },
      center,
      task.input.presentation,
      task,
    );
    task.hosts = center.hosts;
    task.reportId = report.id;
    task.status = "completed";
  }
}
