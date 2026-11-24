import { reportStatistics, reportCoverage } from "./fact-summary";
import { compareReports } from "./comparison";
import { ReportPackageService, ReportPackageController } from "./packages";
import { CollectionConfigurationService } from "../collections/configuration";
import { ReportTaskRunner } from "./task-runner";
import { gzip } from "node:zlib";
import { ReportCenterService, ReportCenterController } from "./center";
import type { ReportCenterFacts } from "../../../../packages/contracts/report-center";
import {
  LifecycleRiskModule,
  LifecycleRiskService,
} from "../lifecycle-risk/lifecycle-risk.module";
import { promisify } from "node:util";
import type { Request, Response } from "express";
import {
  ReportNarrationService,
  ReportNarrationController,
  type ReportNarrationExecutor,
} from "./narration";
import type { Operator } from "../auth/auth";
import { AgentExecutionError } from "../agent/errors";
import { ReportReviewService, ReportReviewController } from "./review";
import type { WindowsAssessment } from "../../../../packages/contracts/windows-assessments";
import {
  ContainersModule,
  ContainerService,
} from "../containers/containers.module";
import { WindowsModule, WindowsService } from "../windows/windows.module";
import {
  WindowsAssessmentsModule,
  WindowsAssessmentService,
} from "../windows-assessments/windows-assessments.module";
import type { WindowsSnapshot } from "../../../../packages/contracts/windows";
import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Header,
  Inject,
  Module,
  NotFoundException,
  Post,
  Req,
  Res,
  StreamableFile,
  type DynamicModule,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DATABASE, type Database } from "../persistence/database";
import { ImportsModule, ImportsService } from "../imports/imports.module";
import { AssessmentService } from "../assessments/assessments.module";
import {
  LifecycleModule,
  LifecycleService,
} from "../lifecycle/lifecycle.module";
import { SoftwareModule, SoftwareService } from "../software/software.module";
import type { AuthorizedRequest } from "../auth/auth";
import type {
  Report,
  ReportFacts,
  ReportRevision,
  ReportScopeTarget,
  ReportSummary,
} from "../../../../packages/contracts/reports";
import { defaultNarrative, renderReport, hashFacts } from "./render";
const inputSchema = z
  .object({
    assessmentRefs: z.array(z.uuid()).max(20).default([]),
    lifecycleRefs: z.array(z.uuid()).max(20).default([]),
  })
  .strict()
  .refine(
    (x) =>
      x.assessmentRefs.length + x.lifecycleRefs.length > 0 &&
      x.assessmentRefs.length + x.lifecycleRefs.length <= 20 &&
      new Set(x.assessmentRefs).size === x.assessmentRefs.length &&
      new Set(x.lifecycleRefs).size === x.lifecycleRefs.length,
  );
export class ReportsService {
  constructor(
    private readonly db: Database,
    private readonly assessments: AssessmentService,
    private readonly lifecycle: LifecycleService,
    private readonly software: SoftwareService,
    private readonly imports: ImportsService,
    private readonly containers: ContainerService,
    private readonly windows: WindowsService,
    private readonly windowsAssessments: WindowsAssessmentService,
  ) {}
  async create(
    customer: string,
    author: string,
    input: z.infer<typeof inputSchema>,
    center?: ReportCenterFacts,
    presentation?: import("../../../../packages/contracts/report-presentation").ReportPresentation,
    finalizingTask?: import("../../../../packages/contracts/report-center").ReportTask,
  ): Promise<Report> {
    const assessmentSnapshots = await Promise.all(
      input.assessmentRefs.map(
        async (id) =>
          (await this.assessments.get(customer, id, {
            includeRawReport: false,
          })) as ReportFacts["assessmentSnapshots"][number],
      ),
    );
    if (
      assessmentSnapshots.some(
        (a) => a.status === "queued" || a.status === "running",
      )
    )
      throw new ConflictException("评估仍在执行，请选择终态结果后生成固定事实");
    const lifecycleSnapshots = await Promise.all(
      input.lifecycleRefs.map((id) =>
        this.lifecycle.getAssessment(customer, id),
      ),
    );
    if (center) {
      for (const snapshot of lifecycleSnapshots)
        snapshot.items = snapshot.items.filter((item) =>
          item.kind === "host"
            ? center.hosts.some(
                (host) =>
                  host.assetId === item.assetId &&
                  String(host.attributes.product ?? "").trim() ===
                    String(item.product ?? "").trim() &&
                  String(host.attributes.version ?? "").trim() ===
                    String(item.version ?? "").trim(),
              )
            : center.objects?.some(
                (object) =>
                  object.kind === item.kind &&
                  object.objectId === item.assetId &&
                  object.versionId === item.versionId,
              ),
        );
    }
    const scope = new Map<string, ReportScopeTarget>(),
      cveTargets = new Set<string>(),
      lifeTargets = new Set<string>();
    const sourceMetadata = new Map<
      string,
      { importedAt: string; collectedAt: string | null }
    >();
    const ruleRefs: ReportFacts["sourceRefs"] = [];
    for (const a of assessmentSnapshots) {
      let target: ReportScopeTarget;
      if (a.target.kind === "windows") {
        const windowsJob = a as WindowsAssessment;
        const snapshot = await this.windows.getSnapshot(
          customer,
          a.target.snapshotId,
        );
        const observed = snapshot.snapshot as WindowsSnapshot;
        const material = await this.windows.get(
          customer,
          windowsJob.input.importId,
        );
        const rules = await this.windowsAssessments.getRules(
          customer,
          windowsJob.input.ruleImportId,
        );
        target = {
          kind: "windows",
          objectId: a.target.assetId,
          versionId: a.target.snapshotId,
          name: observed.hostname,
          version: observed.osVersion ?? observed.fullBuild ?? observed.osBuild,
          sourceIdentity: {
            snapshotId: a.target.snapshotId,
            os: observed.os,
            osBuild: observed.osBuild,
            ubr: observed.ubr,
            architecture: observed.architecture,
          },
        };
        sourceMetadata.set(a.id, {
          importedAt: String(material.importedAt),
          collectedAt: observed.collectedAt,
        });
        ruleRefs.push({
          kind: "windows_rules",
          id: windowsJob.input.ruleImportId,
          inputId: windowsJob.input.ruleImportId,
          contentHash: windowsJob.input.ruleHash,
          ruleVersion: rules.rules.ruleVersion,
          importedAt: String((rules as Record<string, unknown>).importedAt),
          collectedAt: null,
          evaluatedAt: a.finishedAt ?? null,
          toolVersion: a.execution?.toolVersion ?? null,
        });
      } else if (a.target.kind === "linux") {
        const row = (
          await this.db.query(
            "SELECT normalized,created_at FROM collection_snapshots WHERE customer_id=$1 AND id=$2 AND asset_id=$3",
            [customer, a.target.snapshotId, a.target.assetId],
          )
        ).rows[0];
        if (!row) throw new NotFoundException("未找到Linux评估固定快照");
        const observed =
          row.normalized as import("../../../../packages/contracts/collections").HostCollection;
        const os = observed.sections.os?.data as {
          id?: string;
          version?: string;
        };
        target = {
          kind: "linux",
          objectId: a.target.assetId,
          versionId: a.target.snapshotId,
          name: observed.identity.hostname,
          version: os.version ?? null,
          sourceIdentity: {
            snapshotId: a.target.snapshotId,
            snapshotHash:
              "snapshotHash" in a.input ? a.input.snapshotHash : null,
            os: os.id,
            scope: "scope" in a.input ? a.input.scope : null,
          },
        };
        sourceMetadata.set(a.id, {
          importedAt: new Date(row.created_at as string).toISOString(),
          collectedAt: observed.collectedAt,
        });
      } else if (a.target.kind === "container") {
        const image = await this.containers.get(customer, a.target.containerId),
          snapshot = await this.containers.getVersion(
            customer,
            a.target.containerId,
            a.target.versionId,
          ),
          material = await this.imports.get(customer, a.input.importId);
        target = {
          kind: "container",
          objectId: image.id,
          versionId: snapshot.id,
          name: image.name,
          version: snapshot.version,
          sourceIdentity: { ...snapshot.identity, source: image.source },
        };
        sourceMetadata.set(a.id, {
          importedAt: material.importedAt,
          collectedAt: snapshot.collectedAt,
        });
      } else {
        const object = await this.software.get(customer, a.target.softwareId),
          snapshot = await this.software.getVersion(
            customer,
            a.target.softwareId,
            a.target.versionId,
          ),
          material = await this.imports.get(customer, a.input.importId);
        target = {
          kind: "software",
          objectId: object.id,
          versionId: snapshot.id,
          name: object.name,
          version: snapshot.version,
        };
        sourceMetadata.set(a.id, {
          importedAt: material.importedAt,
          collectedAt: snapshot.collectedAt,
        });
      }
      const key = `${target.kind}:${target.objectId}:${target.versionId}`;
      if (cveTargets.has(key))
        throw new ConflictException(
          "同一对象输入版本只能选择一次CVE评估，不累计历史扫描",
        );
      cveTargets.add(key);
      scope.set(key, target);
    }
    for (const a of lifecycleSnapshots)
      for (const item of a.items) {
        const key = `${item.kind}:${item.assetId}:${item.versionId ?? ""}`;
        if (lifeTargets.has(key))
          throw new ConflictException(
            "同一对象输入版本只能选择一次生命周期评估",
          );
        lifeTargets.add(key);
        scope.set(key, {
          kind: item.kind,
          objectId: item.assetId,
          versionId: item.versionId,
          name: item.name,
          version: item.version,
        });
      }
    const coverageIssues = reportCoverage({
      scope: [...scope.values()],
      assessmentSnapshots,
      lifecycleSnapshots,
    });
    const now = new Date().toISOString();
    const sourceRefs: ReportFacts["sourceRefs"] = [];
    sourceRefs.push(
      ...ruleRefs.filter(
        (r, i, all) => all.findIndex((x) => x.id === r.id) === i,
      ),
    );
    for (const a of assessmentSnapshots) {
      const metadata = sourceMetadata.get(a.id)!;
      sourceRefs.push({
        kind: "cve",
        id: a.id,
        outputHash: a.execution?.outputHash,
        inputId: a.input.importId,
        contentHash: a.input.contentHash,
        ruleVersion: a.result?.parserVersion ?? "no-normalized-result",
        ...metadata,
        evaluatedAt: a.finishedAt ?? null,
        toolVersion: a.execution?.toolVersion ?? null,
      });
    }
    for (const a of lifecycleSnapshots) {
      const batch = await this.lifecycle.getBatch(customer, a.batchId);
      sourceRefs.push({
        kind: "lifecycle",
        id: a.id,
        inputId: a.batchId,
        contentHash: a.contentHash,
        ruleVersion: a.ruleVersion,
        importedAt: batch.importedAt,
        collectedAt: null,
        evaluatedAt: a.evaluatedAt,
        toolVersion: null,
      });
    }
    const facts: ReportFacts = {
      ...(center ? { center } : {}),
      schemaVersion: "report-facts-v1",
      customerId: customer,
      generatedAt: now,
      scope: [...scope.values()],
      assessmentSnapshots,
      lifecycleSnapshots,
      sourceRefs,
      statistics: reportStatistics(
        { assessmentSnapshots, lifecycleSnapshots },
        center?.hosts,
      ),
      coverageIssues,
    };
    if (center) {
      for (const host of center.hosts) {
        if (
          !facts.scope.some(
            (target) =>
              target.objectId === host.assetId &&
              ["host", "linux", "windows"].includes(target.kind),
          )
        )
          facts.scope.push({
            kind: "host",
            objectId: host.assetId,
            name: host.name,
            version: null,
            versionId: host.snapshotId ?? undefined,
          });
        facts.coverageIssues.push(
          ...host.issues.map((issue) => `${host.name}：${issue}`),
        );
      }
      for (const object of center.objects ?? []) {
        if (
          !facts.scope.some(
            (target) =>
              target.kind === object.kind &&
              target.objectId === object.objectId &&
              target.versionId === object.versionId,
          )
        )
          facts.scope.push({
            kind: object.kind,
            objectId: object.objectId,
            versionId: object.versionId,
            name: object.name,
            version: null,
          });
      }
    }
    if (center && finalizingTask?.comparisonBase)
      center.comparison = compareReports(facts, finalizingTask.comparisonBase);
    const reportId = randomUUID();
    const revision: ReportRevision = {
      id: randomUUID(),
      reportId,
      customerId: customer,
      number: 1,
      createdAt: now,
      createdBy: author,
      status: "draft",
      factHash: hashFacts(facts),
      facts,
      narrative: {
        ...defaultNarrative(facts),
        ...(center
          ? {
              presentation: presentation ?? {
                topic: "combined",
                optionalChapters: ["summary", "overview", "recommendations"],
              },
            }
          : {}),
      },
      templateVersion: "fixed-report-v1",
    };
    await this.db.transaction(async (s) => {
      if (center) {
        const row = (
          await s.query(
            "SELECT details FROM report_tasks WHERE customer_id=$1 AND id=$2 FOR UPDATE",
            [customer, center.taskId],
          )
        ).rows[0];
        const task = row?.details as
          | import("../../../../packages/contracts/report-center").ReportTask
          | undefined;
        if (
          !task ||
          task.reportId ||
          (finalizingTask && task.status !== finalizingTask.status)
        )
          throw new ConflictException("报告任务状态已变化，请刷新");
        task.reportId = reportId;
        task.status = "completed";
        task.hosts = center.hosts;
        task.frozenScope = center;
        await s.query(
          "UPDATE report_tasks SET status='completed',details=$3::jsonb WHERE customer_id=$1 AND id=$2",
          [customer, center.taskId, JSON.stringify(task)],
        );
      }
      await s.query(
        "INSERT INTO reports(id,customer_id,created_at,created_by) VALUES($1,$2,$3,$4)",
        [reportId, customer, now, author],
      );
      await s.query(
        "INSERT INTO report_revisions(id,customer_id,report_id,number,result) VALUES($1,$2,$3,1,$4::jsonb)",
        [revision.id, customer, reportId, JSON.stringify(revision)],
      );
    });
    return {
      ...(center ? { name: center.name } : {}),
      id: reportId,
      customerId: customer,
      createdAt: now,
      createdBy: author,
      revision,
    };
  }
  async getRevision(
    customer: string,
    reportId: string,
    revisionId: string,
  ): Promise<ReportRevision> {
    const r = await this.db.query(
      "SELECT result FROM report_revisions WHERE customer_id=$1 AND report_id=$2 AND id=$3",
      [customer, reportId, revisionId],
    );
    if (!r.rows.length) throw new NotFoundException("该客户报告下未找到修订");
    return r.rows[0].result as ReportRevision;
  }
  async get(customer: string, id: string): Promise<Report> {
    const r = await this.db.query(
      'SELECT r.id,r.customer_id AS "customerId",r.created_at AS "createdAt",r.created_by AS "createdBy",v.result AS revision FROM reports r JOIN LATERAL (SELECT result FROM report_revisions WHERE customer_id=r.customer_id AND report_id=r.id ORDER BY number DESC LIMIT 1) v ON true WHERE r.customer_id=$1 AND r.id=$2',
      [customer, id],
    );
    if (!r.rows.length) throw new NotFoundException("该客户下未找到报告");
    return {
      ...r.rows[0],
      ...((r.rows[0].revision as ReportRevision).facts.center
        ? { name: (r.rows[0].revision as ReportRevision).facts.center!.name }
        : {}),
      createdAt: new Date(r.rows[0].createdAt as string).toISOString(),
    } as Report;
  }
  async list(customer: string) {
    const rows = await this.db.query(
      `SELECT r.id,r.customer_id AS "customerId",r.created_at AS "createdAt",r.created_by AS "createdBy",
       v.result#>>'{facts,center,name}' AS name,v.id AS "revisionId",v.number AS "revisionNumber",v.result->>'status' AS status,v.result->>'factHash' AS "factHash"
       FROM reports r JOIN LATERAL (SELECT id,number,result FROM report_revisions WHERE customer_id=r.customer_id AND report_id=r.id ORDER BY number DESC LIMIT 1) v ON true
       WHERE r.customer_id=$1 ORDER BY r.created_at DESC,r.id LIMIT 100`,
      [customer],
    );
    return {
      items: rows.rows.map((row) => ({
        ...row,
        createdAt: new Date(row.createdAt as string).toISOString(),
      })) as ReportSummary[],
    };
  }
  async previewRevision(
    customer: string,
    reportId: string,
    revisionId: string,
  ) {
    return renderReport(await this.getRevision(customer, reportId, revisionId));
  }
  async preview(customer: string, id: string) {
    return renderReport((await this.get(customer, id)).revision);
  }
}
const compressReport = promisify(gzip);
async function reportPayload(
  req: AuthorizedRequest & Request,
  response: Response,
  value: unknown,
) {
  response.vary("Accept-Encoding");
  response.setHeader("Cache-Control", "private, no-store");
  if (!req.acceptsEncodings("gzip")) return value;
  const html = typeof value === "string";
  const bytes = await compressReport(html ? value : JSON.stringify(value));
  response.setHeader("Content-Encoding", "gzip");
  return new StreamableFile(bytes, {
    type: html ? "text/html; charset=utf-8" : "application/json",
  });
}
@Controller("api/customers/:customerId/reports")
export class ReportsController {
  constructor(private readonly service: ReportsService) {}
  @Post() async create(req: AuthorizedRequest & Request, response: Response) {
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequestException(
        "需1–20个不重复的明确评估引用，不接受客户端事实",
      );
    return reportPayload(
      req,
      response,
      await this.service.create(
        req.params.customerId,
        req.operator.name,
        parsed.data,
      ),
    );
  }
  @Get() list(req: AuthorizedRequest & Request) {
    return this.service.list(req.params.customerId);
  }
  @Get(":reportId") async get(
    req: AuthorizedRequest & Request,
    response: Response,
  ) {
    this.valid(req.params.reportId);
    return reportPayload(
      req,
      response,
      await this.service.get(req.params.customerId, req.params.reportId),
    );
  }
  @Get(":reportId/preview")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'",
  )
  async preview(req: AuthorizedRequest & Request, response: Response) {
    this.valid(req.params.reportId);
    return reportPayload(
      req,
      response,
      await this.service.preview(req.params.customerId, req.params.reportId),
    );
  }
  @Get(":reportId/revisions/:revisionId") async revision(
    req: AuthorizedRequest & Request,
    response: Response,
  ) {
    this.valid(req.params.reportId);
    this.valid(req.params.revisionId);
    return reportPayload(
      req,
      response,
      await this.service.getRevision(
        req.params.customerId,
        req.params.reportId,
        req.params.revisionId,
      ),
    );
  }
  @Get(":reportId/revisions/:revisionId/preview")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'",
  )
  async revisionPreview(req: AuthorizedRequest & Request, response: Response) {
    this.valid(req.params.reportId);
    this.valid(req.params.revisionId);
    return reportPayload(
      req,
      response,
      await this.service.previewRevision(
        req.params.customerId,
        req.params.reportId,
        req.params.revisionId,
      ),
    );
  }
  private valid(id: string) {
    if (!z.uuid().safeParse(id).success)
      throw new BadRequestException("报告/修订编号无效");
  }
}
for (const method of [
  "create",
  "list",
  "get",
  "preview",
  "revision",
  "revisionPreview",
] as const)
  Req()(ReportsController.prototype, method, 0);
for (const method of [
  "create",
  "get",
  "preview",
  "revision",
  "revisionPreview",
] as const)
  Res({ passthrough: true })(ReportsController.prototype, method, 1);
Inject(ReportsService)(ReportsController, undefined, 0);
@Module({})
export class ReportsModule {
  static register(
    assessmentsModule: DynamicModule,
    options: {
      collectionJobsModule?: DynamicModule;
      executor?: ReportNarrationExecutor;
      operators?: Operator[];
      timeoutMs?: number;
    } = {},
  ): DynamicModule {
    return {
      module: ReportsModule,
      imports: [
        ...(options.collectionJobsModule ? [options.collectionJobsModule] : []),
        LifecycleRiskModule,
        assessmentsModule,
        LifecycleModule,
        SoftwareModule,
        ImportsModule,
        ContainersModule,
        WindowsModule,
        WindowsAssessmentsModule,
      ],
      controllers: [
        ReportPackageController,
        ReportCenterController,
        ReportsController,
        ReportReviewController,
        ReportNarrationController,
      ],
      providers: [
        {
          provide: ReportPackageService,
          inject: [
            DATABASE,
            ReportsService,
            ReportReviewService,
            AssessmentService,
          ],
          useFactory: (
            db: Database,
            reports: ReportsService,
            review: ReportReviewService,
            assessments: AssessmentService,
          ) => new ReportPackageService(db, reports, review, assessments),
        },
        {
          provide: ReportTaskRunner,
          inject: [
            DATABASE,
            AssessmentService,
            WindowsAssessmentService,
            ReportsService,
            CollectionConfigurationService,
            ReportPackageService,
          ],
          useFactory: (
            db: Database,
            assessments: AssessmentService,
            windows: WindowsAssessmentService,
            reports: ReportsService,
            configurations: CollectionConfigurationService,
            packages: ReportPackageService,
          ) =>
            new ReportTaskRunner(
              db,
              assessments,
              windows,
              reports,
              options.operators ?? [],
              configurations,
              packages,
            ),
        },
        {
          provide: ReportCenterService,
          inject: [
            DATABASE,
            ReportsService,
            LifecycleRiskService,
            ReportTaskRunner,
          ],
          useFactory: (
            db: Database,
            reports: ReportsService,
            lifecycle: LifecycleRiskService,
            runner: ReportTaskRunner,
          ) => new ReportCenterService(db, reports, lifecycle, runner),
        },
        {
          provide: ReportNarrationService,
          inject: [DATABASE, ReportsService, ReportReviewService],
          useFactory: (
            db: Database,
            reports: ReportsService,
            review: ReportReviewService,
          ) =>
            new ReportNarrationService(
              db,
              reports,
              review,
              options.executor ?? {
                execute: async () => {
                  throw new AgentExecutionError(
                    "unavailable",
                    "Pi报告叙述未配置，固定事实草稿保留",
                  );
                },
              },
              options.operators ?? [],
              options.timeoutMs,
            ),
        },
        {
          provide: ReportReviewService,
          inject: [DATABASE],
          useFactory: (db: Database) => new ReportReviewService(db),
        },
        {
          provide: ReportsService,
          inject: [
            DATABASE,
            AssessmentService,
            LifecycleService,
            SoftwareService,
            ImportsService,
            ContainerService,
            WindowsService,
            WindowsAssessmentService,
          ],
          useFactory: (
            db: Database,
            a: AssessmentService,
            l: LifecycleService,
            s: SoftwareService,
            i: ImportsService,
            c: ContainerService,
            w: WindowsService,
            wa: WindowsAssessmentService,
          ) => new ReportsService(db, a, l, s, i, c, w, wa),
        },
      ],
      exports: [ReportsService, ReportReviewService, ReportNarrationService],
    };
  }
}
