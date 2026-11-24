import type { ReportPackageService } from "./packages";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { ReportTask } from "../../../../packages/contracts/report-center";
import type { Database } from "../persistence/database";
import type { Operator } from "../auth/auth";
import type { AssessmentService } from "../assessments/assessments.module";
import type { WindowsAssessmentService } from "../windows-assessments/windows-assessments.module";
import type { ReportsService } from "./reports.module";
import type { CollectionConfigurationService } from "../collections/configuration";
import type {
  CollectionConfiguration,
  ConfigurationRun,
} from "../../../../packages/contracts/collection-configuration";
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
    private configurations: CollectionConfigurationService,
    private packages: ReportPackageService,
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
  async plan(task: ReportTask) {
    const incremental = task.input.mode === "incremental";
    task.items = task.hosts.map((host) => ({
      id: randomUUID(),
      name: host.name,
      kind: "linux",
      objectId: host.assetId,
      hostIds: [host.assetId],
      snapshotId: host.snapshotId,
      attempt: 0,
      status: "pending" as const,
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
    for (const item of task.items) {
      const host = task.hosts.find((host) => host.assetId === item.objectId);
      const object = task.frozenScope?.objects?.find(
        (object) =>
          object.objectId === item.objectId &&
          object.versionId === item.snapshotId,
      );
      const collectionFreshness =
        host?.freshness.collection ??
        object?.freshness?.collection ??
        "unknown";
      item.needsCollection =
        (task.input.mode === "collect" && !!host) ||
        (incremental &&
          collectionFreshness !== "fresh" &&
          !task.input.allowExistingCollection);
      if (item.needsCollection && host)
        item.collectionConfiguration =
          ((await this.configurations.get(
            task.customerId,
            item.objectId,
          )) as CollectionConfiguration | null) ?? undefined;
      if (item.needsCollection) continue;
      if (incremental && item.snapshotId) {
        const job = (
          await this.db.query(
            "SELECT id,details->>'finishedAt' AS finished FROM vulnerability_jobs WHERE customer_id=$1 AND target_object_id=$2 AND target_input_id=$3 AND status='succeeded' ORDER BY created_at DESC,id DESC LIMIT 1",
            [task.customerId, item.objectId, item.snapshotId],
          )
        ).rows[0];
        const age = job
          ? Date.parse(task.createdAt) - Date.parse(String(job.finished))
          : NaN;
        if (age >= 0 && age <= task.input.freshnessDays * 86400000) {
          item.status = "reused";
          item.assessmentId = String(job.id);
        }
      }
    }
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
        if (item.needsCollection) {
          if (!["linux", "windows"].includes(item.kind)) {
            item.status = "waiting_upload";
            item.error =
              "关联 SBOM 资料陈旧或缺少来源时间；需在主机资料页补齐并明确关联新版本后新建报告，或明确采用现有资料。可结束等待生成缺口报告";
            await this.save(task);
            continue;
          }
          const ready = await this.collect(task, item);
          if (!ready) {
            await this.save(task);
            continue;
          }
        }
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
          const currentTask = await this.load(customer, id);
          if (currentTask.status === "cancelled") {
            currentTask.items!.find(
              (saved) => saved.id === item.id,
            )!.assessmentId = job.id;
            await this.save(currentTask);
            return;
          }
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
        ["waiting_upload", "waiting_confirmation"].includes(item.status),
      )
    )
      task.status = "waiting";
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
  private async collect(
    task: ReportTask,
    item: import("../../../../packages/contracts/report-center").ReportTaskItem,
  ) {
    if (!item.collectionConfiguration)
      item.collectionConfiguration =
        ((await this.configurations.get(
          task.customerId,
          item.objectId,
        )) as CollectionConfiguration | null) ?? undefined;
    if (!item.collectionConfiguration) {
      item.status = "waiting_upload";
      item.error =
        "未保存采集配置；请到资产采集配置设置接入方式，再明确继续任务，或结束等待生成缺口报告";
      return false;
    }
    let run: ConfigurationRun;
    if (!item.collectionRunId) {
      run = await this.configurations.run(
        task.customerId,
        item.objectId,
        `report:${task.id}:${item.id}:${item.attempt}`,
        item.collectionConfiguration,
        async () => {
          await this.authorized(task);
          return (
            !this.stopping &&
            (await this.load(task.customerId, task.id)).status !== "cancelled"
          );
        },
      );
      item.collectionRunId = run.id;
      await this.save(task);
    } else
      run = await this.configurations.read(
        task.customerId,
        item.collectionRunId,
      );
    while (
      run.items.some((part) =>
        ["queued", "running", "submitting"].includes(part.status),
      ) &&
      !this.stopping
    ) {
      if ((await this.load(task.customerId, task.id)).status === "cancelled")
        return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
      run = await this.configurations.read(
        task.customerId,
        item.collectionRunId,
      );
    }
    if (this.stopping) {
      item.status = "interrupted";
      return false;
    }
    const parts = run.items.filter((part) => part.content !== "docker");
    if (parts.some((part) => part.status === "awaiting_input")) {
      item.status = "waiting_upload";
      item.error =
        "等待本采集批次的脚本上传或人工资料；请在资产采集页面绑定后继续";
      return false;
    }
    const snapshotId = parts.find((part) => part.snapshotId)?.snapshotId;
    if (!snapshotId)
      throw new ConflictException(
        parts.map((part) => part.error ?? part.status).join("；") ||
          "配置未包含主机评估所需资料",
      );
    const snapshot = (
      await this.db.query(
        "SELECT normalized FROM collection_snapshots WHERE customer_id=$1 AND asset_id=$2 AND id=$3",
        [task.customerId, item.objectId, snapshotId],
      )
    ).rows[0];
    if (!snapshot)
      throw new ConflictException("本次采集未产生目标的可读取资料");
    const rejected = await this.db.query(
      "SELECT snapshot_id FROM collection_rejections WHERE customer_id=$1 AND snapshot_id=$2",
      [task.customerId, snapshotId],
    );
    if (rejected.rows.length)
      throw new ConflictException(
        "本任务资料已拒绝采纳；请结束等待并生成覆盖报告，或重新采集",
      );
    const accepted = await this.db.query(
      `SELECT id FROM asset_baselines WHERE customer_id=$1 AND asset_id=$2 AND snapshot_id=$3 AND status='confirmed' AND plan#>'{selection,sections}' @> '["os","packages"]'::jsonb AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(plan#>'{selection,excludeFields}','[]'::jsonb)) field WHERE field LIKE 'os.%' OR field LIKE 'packages.%')`,
      [task.customerId, item.objectId, snapshotId],
    );
    if (!accepted.rows.length) {
      item.status = "waiting_confirmation";
      item.error =
        "等待既有资料确认：需明确采纳本批次完整 OS 和包清单；未确认不发起评估";
      item.snapshotId = snapshotId;
      return false;
    }
    item.snapshotId = snapshotId;
    item.needsCollection = false;
    const normalized = snapshot.normalized as { collectedAt: string | null };
    const host = task.frozenScope!.hosts.find(
      (host) => host.assetId === item.objectId,
    )!;
    host.snapshotId = snapshotId;
    host.collectedAt = normalized.collectedAt;
    const age = normalized.collectedAt
      ? Date.now() - Date.parse(normalized.collectedAt)
      : NaN;
    host.freshness.collection =
      !Number.isFinite(age) || age < 0
        ? "unknown"
        : age > task.input.freshnessDays * 86400000
          ? "stale"
          : "fresh";
    delete item.error;
    return true;
  }
  private async change(
    customer: string,
    id: string,
    update: (task: ReportTask) => void,
  ) {
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.query(
          "SELECT details FROM report_tasks WHERE customer_id=$1 AND id=$2 FOR UPDATE",
          [customer, id],
        )
      ).rows[0];
      if (!row) throw new NotFoundException("该客户下未找到报告任务");
      const task = row.details as ReportTask;
      update(task);
      await tx.query(
        "UPDATE report_tasks SET status=$3,details=$4::jsonb WHERE customer_id=$1 AND id=$2",
        [customer, id, task.status, JSON.stringify(task)],
      );
      return task;
    });
  }
  async resume(customer: string, id: string) {
    const task = await this.change(customer, id, (task) => {
      if (this.active.has(id) || task.status !== "waiting" || task.reportId)
        throw new ConflictException("当前任务不处于等待资料状态");
      for (const item of task.items ?? [])
        if (["waiting_upload", "waiting_confirmation"].includes(item.status))
          item.status = "pending";
      task.status = "queued";
    });
    this.start(customer, id);
    return task;
  }
  async retry(customer: string, id: string, itemIds: string[]) {
    const task = await this.change(customer, id, (task) => {
      if (
        task.reportId ||
        this.active.has(id) ||
        !["needs_attention", "interrupted", "failed", "waiting"].includes(
          task.status,
        )
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
        if (item.needsCollection && item.collectionRunId) {
          item.previousCollectionRunIds = [
            ...(item.previousCollectionRunIds ?? []),
            item.collectionRunId,
          ];
          delete item.collectionRunId;
          item.snapshotId = null;
        }
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
    });
    this.start(customer, id);
    return task;
  }
  async cancel(customer: string, id: string) {
    const task = await this.change(customer, id, (task) => {
      if (task.reportId) throw new ConflictException("已固定报告不能取消");
      task.status = "cancelled";
      task.cancelledAt ??= new Date().toISOString();
      for (const item of task.items ?? [])
        if (
          [
            "pending",
            "running",
            "waiting_upload",
            "waiting_confirmation",
          ].includes(item.status)
        )
          item.status = "cancelled";
    });
    return task;
  }
  async finish(customer: string, id: string) {
    const task = await this.load(customer, id);
    if (
      this.active.has(id) ||
      ![
        "needs_attention",
        "cancelled",
        "interrupted",
        "failed",
        "waiting",
      ].includes(task.status)
    )
      throw new ConflictException("请等待执行结束或取消后再生成覆盖报告");
    await this.finalize(task);
    return task;
  }
  private async finalize(task: ReportTask) {
    const center = task.frozenScope!;
    for (const host of task.input.mode === "existing" ? [] : center.hosts) {
      host.issues = host.issues.filter(
        (issue) =>
          !issue.startsWith("未取得当前已确认资料对应") &&
          !issue.startsWith("最近评估 "),
      );

      const items = (task.items ?? []).filter((item) =>
        item.hostIds.includes(host.assetId),
      );
      host.assessmentRefs = items.flatMap((item) =>
        item.assessmentId &&
        !["cancelled", "pending", "running"].includes(item.status)
          ? [item.assessmentId]
          : [],
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
      if (
        own?.assessmentId &&
        ["succeeded", "reused", "failed", "interrupted"].includes(own.status)
      ) {
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
    for (const object of task.input.mode === "existing"
      ? []
      : (center.objects ?? [])) {
      const item = task.items?.find(
        (item) =>
          item.objectId === object.objectId &&
          item.snapshotId === object.versionId,
      );
      object.assessmentId = item?.assessmentId ?? null;
      if (item?.assessmentId && ["succeeded", "reused"].includes(item.status)) {
        const assessment = await this.assessments.get(
          task.customerId,
          item.assessmentId,
          { includeRawReport: false },
        );
        object.assessedAt = assessment.finishedAt ?? null;
        object.freshness = {
          collection: object.freshness?.collection ?? "unknown",
          assessment: "fresh",
        };
      }
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
    await this.package(task);
  }
  async package(task: ReportTask) {
    if (!task.input.output || !task.reportId) return;
    const report = await this.reports.get(task.customerId, task.reportId);
    const bundle = await this.packages.create(
      task.customerId,
      task.reportId,
      report.revision.id,
      task.createdBy,
      {
        audience: "draft",
        pdfMode: task.input.output.pdfMode,
        perHostIds: task.input.output.perHost
          ? task.hosts.map((host) => host.assetId)
          : [],
        evidenceAssessmentIds: task.input.output.evidence
          ? report.revision.facts.assessmentSnapshots.map((a) => a.id)
          : [],
      },
    );
    task.packageId = bundle.id;
    await this.db.query(
      "UPDATE report_tasks SET details=jsonb_set(details,'{packageId}',to_jsonb($3::text)) WHERE customer_id=$1 AND id=$2",
      [task.customerId, task.id, bundle.id],
    );
  }
}
