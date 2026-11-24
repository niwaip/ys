import { ContainerGenerationModule } from "./container-runtime/jobs.module";
import type { ImageGenerator } from "./container-runtime/generator";
import { ContainerRuntimeModule } from "./container-runtime/container-runtime.module";
import { LifecycleRiskModule } from "./lifecycle-risk/lifecycle-risk.module";
import { CveRecordResearch } from "./finding-analysis/public-cve";
import { FindingAnalysisModule } from "./finding-analysis/finding-analysis.module";
import {
  configuredFindingAnalyst,
  type FindingAnalysisExecutor,
} from "./finding-analysis/pi-analysis";
import type { PublicQueryExecutor } from "./agent/agent.module";
import { BaselinesModule } from "./baselines/baselines.module";
import { CollectionJobsModule } from "./collections/jobs.module";
import type { CollectionExecutor } from "./collections/pi-collection";
import { CollectionsModule } from "./collections/collections.module";
import { NetBoxModule, NetBoxService } from "./netbox/netbox.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { configuredReportNarrator } from "./reports/pi-narration";
import type { ReportNarrationExecutor } from "./reports/narration";
import "reflect-metadata";
import { Inject, Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { json } from "express";
import { configSchema, type AppConfig } from "./config";
import { openDatabase, DATABASE } from "./persistence/database";
import { OperatorGuard } from "./auth/auth";
import { CustomersController } from "./customers/customers.controller";
import { AssetsController } from "./assets/assets.controller";
import { AssetsService } from "./assets/assets.service";
import { ImportsModule } from "./imports/imports.module";
import { LifecycleModule } from "./lifecycle/lifecycle.module";
import { SoftwareModule } from "./software/software.module";
import { WindowsModule } from "./windows/windows.module";
import { configuredPublicExecutor } from "./agent/pi-process";
import { AgentModule } from "./agent/agent.module";
import { AssessmentsModule } from "./assessments/assessments.module";
import { ProcessTrivyExecutor, type TrivyExecutor } from "./assessments/trivy";
import { ContainersModule } from "./containers/containers.module";
import { ReportsModule } from "./reports/reports.module";
import { SoftwareHistoryModule } from "./software-history/software-history.module";
import { ConversationsModule } from "./conversations/conversations.module";
import {
  configuredCustomerExecutor,
  type CustomerReadExecutor,
} from "./conversations/pi-customer";
const CONFIG = Symbol("APP_CONFIG");
Inject(CONFIG)(OperatorGuard, undefined, 0);
Inject(CONFIG)(CustomersController, undefined, 0);
Inject(AssetsService)(AssetsController, undefined, 0);
@Module({})
class ApplicationModule {}
/** Feature modules can import exported DATABASE and OperatorGuard from this shared core. */
@Module({})
export class CoreModule {
  static register(
    config: AppConfig,
    database: Awaited<ReturnType<typeof openDatabase>>,
  ): DynamicModule {
    return {
      module: CoreModule,
      global: true,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: DATABASE, useValue: database },
        OperatorGuard,
        { provide: APP_GUARD, useExisting: OperatorGuard },
      ],
      exports: [CONFIG, DATABASE, OperatorGuard],
    };
  }
}
@Module({
  controllers: [AssetsController],
  providers: [
    {
      provide: AssetsService,
      inject: [DATABASE, NetBoxService],
      useFactory: (
        db: Awaited<ReturnType<typeof openDatabase>>,
        netbox: NetBoxService,
      ) => new AssetsService(db, netbox),
    },
  ],
  exports: [AssetsService],
})
export class AssetsModule {}
export async function createApp(
  input: AppConfig,
  features: DynamicModule["imports"] = [],
  runtime: {
    findingAnalysisExecutor?: FindingAnalysisExecutor;
    findingResearchExecutor?: PublicQueryExecutor;
    findingAnalysisTimeoutMs?: number;
    collectionExecutor?: CollectionExecutor;
    imageGenerator?: ImageGenerator;
    trivyExecutor?: TrivyExecutor;
    reportNarrationExecutor?: ReportNarrationExecutor;
    reportNarrationTimeoutMs?: number;
    customerReadExecutor?: CustomerReadExecutor;
  } = {},
) {
  const config = configSchema.parse(input);
  const database = await openDatabase(config.databaseUrl);
  try {
    for (const customer of config.customers)
      await database.query(
        "INSERT INTO customers (id,name) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name",
        [customer.id, customer.name],
      );
    // Report-owned external work requires explicit retry after restart, including
    // submissions reserved before their worker had begun executing.
    await database.query(
      `UPDATE vulnerability_jobs SET status='interrupted',details=details || '{"error":"报告任务因服务重启中断，需明确重试"}'::jsonb WHERE idempotency_key LIKE 'report:%' AND status IN ('queued','running')`,
    );
    await database.query(
      `UPDATE collection_jobs SET status='interrupted',details=details || '{"status":"interrupted","error":"报告采集因服务重启中断，未自动重连"}'::jsonb WHERE status IN ('queued','running') AND id IN (SELECT (part->>'jobId')::uuid FROM collection_configuration_runs r CROSS JOIN LATERAL jsonb_array_elements(r.details->'items') part WHERE r.id IN (SELECT (item->>'collectionRunId')::uuid FROM report_tasks t CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.details->'items','[]'::jsonb)) item WHERE item->>'collectionRunId' IS NOT NULL) AND part->>'jobId' IS NOT NULL)`,
    );
    const assessments = AssessmentsModule.register(
      runtime.trivyExecutor ?? new ProcessTrivyExecutor(config.trivy),
    );
    const history = SoftwareHistoryModule.register(assessments);
    const collectionJobs = CollectionJobsModule.register(
      config,
      runtime.collectionExecutor,
    );
    const app = await NestFactory.create(
      {
        module: ApplicationModule,
        imports: [
          CoreModule.register(config, database),
          NetBoxModule.register(config.netbox),
          AssetsModule,
          CollectionsModule,
          BaselinesModule,
          collectionJobs,
          ImportsModule,
          LifecycleModule,
          LifecycleRiskModule,
          SoftwareModule,
          ContainersModule,
          ContainerRuntimeModule,
          ContainerGenerationModule.register(
            collectionJobs,
            assessments,
            runtime.imageGenerator,
          ),
          WindowsModule,
          ...(!features.some(
            (f) =>
              typeof f === "object" &&
              f !== null &&
              "module" in f &&
              f.module === AgentModule,
          )
            ? [AgentModule.register(configuredPublicExecutor(config.pi))]
            : []),
          FindingAnalysisModule.register({
            executor:
              runtime.findingAnalysisExecutor ??
              configuredFindingAnalyst(config.pi),
            researcher:
              runtime.findingResearchExecutor ??
              (config.pi?.scriptPath
                ? configuredPublicExecutor(config.pi)
                : new CveRecordResearch()),
            operators: config.operators,
            model:
              [config.pi?.provider, config.pi?.model]
                .filter(Boolean)
                .join("/") || "未配置",
            timeoutMs: runtime.findingAnalysisTimeoutMs ?? config.pi?.timeoutMs,
          }),
          assessments,
          ReportsModule.register(assessments, {
            collectionJobsModule: collectionJobs,
            executor:
              runtime.reportNarrationExecutor ??
              configuredReportNarrator(config.pi),
            operators: config.operators,
            timeoutMs: runtime.reportNarrationTimeoutMs ?? config.pi?.timeoutMs,
          }),
          history,
          DashboardModule.register(assessments, history),
          ConversationsModule.register(
            assessments,
            runtime.customerReadExecutor ??
              configuredCustomerExecutor(config.pi),
          ),
          ...features,
        ],
        controllers: [CustomersController],
        providers: [
          {
            provide: "database-lifecycle",
            useValue: { onApplicationShutdown: () => database.close() },
          },
        ],
      },
      { logger: false, bodyParser: false },
    );
    app.use("/api/customers/:customerId/collections", json({ limit: "8mb" }));
    app.use("/api/customers/:customerId/containers", json({ limit: "32mb" }));
    app.use(
      "/api/customers/:customerId/container-runtime",
      json({ limit: "32mb" }),
    );
    app.use(json({ limit: "1mb" }));
    await app.init();
    return app;
  } catch (error) {
    await database.close();
    throw error;
  }
}
