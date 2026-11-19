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
  ): Promise<Report> {
    const assessmentSnapshots = await Promise.all(
      input.assessmentRefs.map(
        async (id) =>
          (await this.assessments.get(
            customer,
            id,
          )) as ReportFacts["assessmentSnapshots"][number],
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
    const coverageIssues: string[] = [];
    for (const [key, t] of scope) {
      if (!cveTargets.has(key))
        coverageIssues.push(
          `${t.name} / ${t.version ?? "未知版本"}：未选择CVE评估，未评估`,
        );
      if (!lifeTargets.has(key))
        coverageIssues.push(
          `${t.name} / ${t.version ?? "未知版本"}：未选择生命周期评估，未评估`,
        );
    }
    for (const a of assessmentSnapshots) {
      if (a.target.kind !== "software")
        throw new BadRequestException("此报告适配器仅支持软件目标");
      if (!a.result)
        coverageIssues.push(
          `CVE评估 ${a.id}：${a.status}，无可用结果，不是零漏洞`,
        );
      else {
        coverageIssues.push(
          `CVE评估 ${a.id}：覆盖 ${a.result.coverage.status}，情报库 ${a.result.database.freshness}`,
          ...a.result.coverage.issues.map((x) => `CVE评估 ${a.id}：${x}`),
        );
      }
    }
    for (const a of lifecycleSnapshots)
      for (const item of a.items) {
        if (item.match !== "exact")
          coverageIssues.push(
            `生命周期 ${item.assetId}：${item.match} / ${item.verification}`,
          );
        for (const e of item.evidence)
          for (const [name, s] of [
            ["EOS", e.eos],
            ["EOL", e.eol],
          ] as const)
            if (s.dateStatus !== "known")
              coverageIssues.push(
                `生命周期 ${item.assetId} ${name}：${s.dateStatus}，日期未知`,
              );
      }
    const findings: {
        severity: string;
        vulnerabilityId: string;
        applicability: string;
      }[] = assessmentSnapshots.reduce<
        { severity: string; vulnerabilityId: string; applicability: string }[]
      >((all, a) => [...all, ...(a.result?.findings ?? [])], []),
      severityCounts: Record<string, number> = Object.create(null);
    for (const finding of findings)
      severityCounts[finding.severity] =
        (severityCounts[finding.severity] ?? 0) + 1;
    const lifecycleItems = lifecycleSnapshots.flatMap((a) => a.items),
      now = new Date().toISOString();
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
      schemaVersion: "report-facts-v1",
      customerId: customer,
      generatedAt: now,
      scope: [...scope.values()],
      assessmentSnapshots,
      lifecycleSnapshots,
      sourceRefs,
      statistics: {
        confirmedAffectedCount: assessmentSnapshots.some((a) => a.result)
          ? findings.filter((v) => v.applicability === "affected").length
          : null,
        applicabilityCounts: Object.fromEntries(
          [...new Set(findings.map((v) => v.applicability))].map((key) => [
            key,
            findings.filter((v) => v.applicability === key).length,
          ]),
        ),
        findingInstances: assessmentSnapshots.some((a) => a.result)
          ? findings.length
          : null,
        uniqueCveCount: assessmentSnapshots.some((a) => a.result)
          ? new Set(
              findings
                .filter((v) => /^CVE-\d{4}-\d{4,}$/.test(v.vulnerabilityId))
                .map((v) => v.vulnerabilityId),
            ).size
          : null,
        severityCounts,
        lifecycleExact: lifecycleSnapshots.length
          ? lifecycleItems.filter((i) => i.match === "exact").length
          : null,
        lifecycleWeak: lifecycleSnapshots.length
          ? lifecycleItems.filter((i) => i.match === "weak").length
          : null,
        lifecycleUnmatched: lifecycleSnapshots.length
          ? lifecycleItems.filter((i) => i.match === "unmatched").length
          : null,
      },
      coverageIssues,
    };
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
      narrative: defaultNarrative(facts),
      templateVersion: "fixed-report-v1",
    };
    await this.db.transaction(async (s) => {
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
      createdAt: new Date(r.rows[0].createdAt as string).toISOString(),
    } as Report;
  }
  async list(customer: string) {
    const r = await this.db.query(
      "SELECT id FROM reports WHERE customer_id=$1 ORDER BY created_at DESC,id LIMIT 100",
      [customer],
    );
    const items: ReportSummary[] = [];
    for (const row of r.rows) {
      const { revision, ...base } = await this.get(customer, String(row.id));
      items.push({
        ...base,
        revisionId: revision.id,
        revisionNumber: revision.number,
        status: revision.status,
        factHash: revision.factHash,
      });
    }
    return { items };
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
@Controller("api/customers/:customerId/reports")
export class ReportsController {
  constructor(private readonly service: ReportsService) {}
  @Post() create(req: AuthorizedRequest) {
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequestException(
        "需1–20个不重复的明确评估引用，不接受客户端事实",
      );
    return this.service.create(
      req.params.customerId,
      req.operator.name,
      parsed.data,
    );
  }
  @Get() list(req: AuthorizedRequest) {
    return this.service.list(req.params.customerId);
  }
  @Get(":reportId") get(req: AuthorizedRequest) {
    this.valid(req.params.reportId);
    return this.service.get(req.params.customerId, req.params.reportId);
  }
  @Get(":reportId/preview")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'",
  )
  preview(req: AuthorizedRequest) {
    this.valid(req.params.reportId);
    return this.service.preview(req.params.customerId, req.params.reportId);
  }
  @Get(":reportId/revisions/:revisionId") revision(req: AuthorizedRequest) {
    this.valid(req.params.reportId);
    this.valid(req.params.revisionId);
    return this.service.getRevision(
      req.params.customerId,
      req.params.reportId,
      req.params.revisionId,
    );
  }
  @Get(":reportId/revisions/:revisionId/preview")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'",
  )
  revisionPreview(req: AuthorizedRequest) {
    this.valid(req.params.reportId);
    this.valid(req.params.revisionId);
    return this.service.previewRevision(
      req.params.customerId,
      req.params.reportId,
      req.params.revisionId,
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
Inject(ReportsService)(ReportsController, undefined, 0);
@Module({})
export class ReportsModule {
  static register(assessmentsModule: DynamicModule): DynamicModule {
    return {
      module: ReportsModule,
      imports: [
        assessmentsModule,
        LifecycleModule,
        SoftwareModule,
        ImportsModule,
        ContainersModule,
        WindowsModule,
        WindowsAssessmentsModule,
      ],
      controllers: [ReportsController],
      providers: [
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
      exports: [ReportsService],
    };
  }
}
