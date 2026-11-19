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
      inject: [DATABASE],
      useFactory: (db: Awaited<ReturnType<typeof openDatabase>>) =>
        new AssetsService(db),
    },
  ],
  exports: [AssetsService],
})
export class AssetsModule {}
export async function createApp(
  input: AppConfig,
  features: DynamicModule["imports"] = [],
  runtime: {
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
    const assessments = AssessmentsModule.register(
      runtime.trivyExecutor ?? new ProcessTrivyExecutor(config.trivy),
    );
    const history = SoftwareHistoryModule.register(assessments);
    const app = await NestFactory.create(
      {
        module: ApplicationModule,
        imports: [
          CoreModule.register(config, database),
          AssetsModule,
          ImportsModule,
          LifecycleModule,
          SoftwareModule,
          ContainersModule,
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
          assessments,
          ReportsModule.register(assessments, {
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
    app.use(json({ limit: "1mb" }));
    await app.init();
    return app;
  } catch (error) {
    await database.close();
    throw error;
  }
}
