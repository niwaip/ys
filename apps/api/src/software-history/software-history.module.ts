import {
  BadRequestException,
  ConflictException,
  Controller,
  DynamicModule,
  Get,
  HttpCode,
  Inject,
  Module,
  NotFoundException,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { z } from "zod";
import { DATABASE, type Database } from "../persistence/database";
import { SoftwareModule, SoftwareService } from "../software/software.module";
import { AssessmentService } from "../assessments/assessments.module";
import type { AuthorizedRequest } from "../auth/auth";
import type { Assessment } from "../../../../packages/contracts/assessments";
import type {
  SoftwareHistory,
  SoftwareCurrent,
  SoftwareComparison,
  ComparisonContext,
} from "../../../../packages/contracts/software-history";
import { compareSoftware } from "./compare";
const pageSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(1000000).default(0),
  })
  .strict();
const currentSchema = z
  .object({ versionId: z.uuid(), assessmentId: z.uuid().nullable().optional() })
  .strict();
export class SoftwareHistoryService {
  constructor(
    private readonly db: Database,
    private readonly software: SoftwareService,
    private readonly assessments: AssessmentService,
  ) {}
  private async object(customer: string, id: string) {
    const r = await this.db.query(
      'SELECT id,name,customer_id AS "customerId" FROM software_objects WHERE customer_id=$1 AND id=$2',
      [customer, id],
    );
    if (!r.rows.length) throw new NotFoundException("该客户下未找到软件对象");
    return r.rows[0] as SoftwareHistory["software"];
  }
  async current(customer: string, id: string): Promise<SoftwareCurrent | null> {
    await this.object(customer, id);
    const r = await this.db.query(
      `SELECT c.version_id AS "versionId",c.assessment_id AS "assessmentId",c.selected_at AS "selectedAt",v.version FROM software_current c JOIN software_versions v ON v.customer_id=c.customer_id AND v.id=c.version_id WHERE c.customer_id=$1 AND c.software_id=$2`,
      [customer, id],
    );
    return r.rows.length
      ? ({
          ...r.rows[0],
          selectedAt: new Date(r.rows[0].selectedAt as string).toISOString(),
          selection: "explicit",
        } as SoftwareCurrent)
      : null;
  }
  async history(
    customer: string,
    id: string,
    page: { limit?: number; offset?: number } = {},
  ): Promise<SoftwareHistory> {
    const paging = pageSchema.safeParse(page);
    if (!paging.success) throw new BadRequestException("分页无效");
    const { limit, offset } = paging.data;
    const object = await this.object(customer, id);
    const r = await this.db.query(
      `SELECT v.id,v.version,v.import_id AS "importId",v.created_at AS "createdAt",v.details->'collectedAt' AS "collectedAt",jsonb_array_length(v.details->'components') AS "componentCount",v.details->'issues' AS issues,m.content_hash AS "contentHash",m.file_name AS "fileName" FROM software_versions v JOIN import_materials m ON m.customer_id=v.customer_id AND m.id=v.import_id WHERE v.customer_id=$1 AND v.software_id=$2 ORDER BY v.created_at DESC,v.id LIMIT $3 OFFSET $4`,
      [customer, id, limit, offset],
    );
    const count = await this.db.query(
      "SELECT count(*)::int AS total FROM software_versions WHERE customer_id=$1 AND software_id=$2",
      [customer, id],
    );
    return {
      software: object,
      current: await this.current(customer, id),
      versions: {
        items: r.rows.map((row) => ({
          ...row,
          createdAt: new Date(row.createdAt as string).toISOString(),
        })) as SoftwareHistory["versions"]["items"],
        total: Number(count.rows[0].total),
        limit,
        offset,
      },
    };
  }
  async selectCurrent(
    customer: string,
    id: string,
    input: z.infer<typeof currentSchema>,
  ) {
    await this.object(customer, id);
    const snapshot = await this.software.getVersion(
      customer,
      id,
      input.versionId,
    );
    if (input.assessmentId) {
      const a = await this.assessments.get(customer, input.assessmentId);
      if (
        a.target.kind !== "software" ||
        a.target.softwareId !== id ||
        a.target.versionId !== input.versionId
      )
        throw new ConflictException("当前批次必须属于该软件及所选输入版本");
    }
    await this.db.query(
      `INSERT INTO software_current(customer_id,software_id,version_id,assessment_id) VALUES($1,$2,$3,$4) ON CONFLICT(customer_id,software_id) DO UPDATE SET version_id=EXCLUDED.version_id,assessment_id=EXCLUDED.assessment_id,selected_at=now()`,
      [customer, id, snapshot.id, input.assessmentId ?? null],
    );
    return this.current(customer, id);
  }
  async batch(
    customer: string,
    id: string,
    assessmentId: string,
  ): Promise<Assessment> {
    await this.object(customer, id);
    const a = await this.assessments.get(customer, assessmentId);
    if (a.target.kind !== "software" || a.target.softwareId !== id)
      throw new NotFoundException("该软件下未找到所选软件评估批次");
    return a as Assessment;
  }
  async compare(
    customer: string,
    id: string,
    input: {
      baselineId: string;
      comparedId: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<SoftwareComparison> {
    if (input.baselineId === input.comparedId)
      throw new BadRequestException("请选择两个不同的评估批次");
    const page = pageSchema.safeParse({
      limit: input.limit,
      offset: input.offset,
    });
    if (!page.success) throw new BadRequestException("分页无效");
    const baseline = await this.batch(customer, id, input.baselineId),
      compared = await this.batch(customer, id, input.comparedId);
    if (
      baseline.target.kind !== "software" ||
      compared.target.kind !== "software"
    )
      throw new BadRequestException("仅支持软件评估比较");
    const oldInput = await this.software.getVersion(
        customer,
        id,
        baseline.target.versionId,
      ),
      newInput = await this.software.getVersion(
        customer,
        id,
        compared.target.versionId,
      );
    return compareSoftware(
      id,
      baseline,
      compared,
      oldInput.components,
      newInput.components,
      page.data,
    );
  }
}
@Controller("api/customers/:customerId/software/:softwareId/history")
class SoftwareHistoryController {
  constructor(private readonly history: SoftwareHistoryService) {}
  @Get() get(req: AuthorizedRequest) {
    this.valid(req);
    const page = pageSchema.safeParse(req.query);
    if (!page.success) throw new BadRequestException("分页无效");
    return this.history.history(
      req.params.customerId,
      req.params.softwareId,
      page.data,
    );
  }
  @Get("current") current(req: AuthorizedRequest) {
    this.valid(req);
    return this.history.current(req.params.customerId, req.params.softwareId);
  }
  @Put("current") selectCurrent(req: AuthorizedRequest) {
    this.valid(req);
    const input = currentSchema.safeParse(req.body);
    if (!input.success)
      throw new BadRequestException("需所选输入版本与可选评估编号");
    return this.history.selectCurrent(
      req.params.customerId,
      req.params.softwareId,
      input.data,
    );
  }
  @Get("assessments/:assessmentId") batch(req: AuthorizedRequest) {
    this.valid(req);
    if (!z.uuid().safeParse(req.params.assessmentId).success)
      throw new BadRequestException("评估编号无效");
    return this.history.batch(
      req.params.customerId,
      req.params.softwareId,
      req.params.assessmentId,
    );
  }
  @Post("compare") @HttpCode(200) compare(req: AuthorizedRequest) {
    this.valid(req);
    const input = z
      .object({
        baselineId: z.uuid(),
        comparedId: z.uuid(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).max(1000000).optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!input.success)
      throw new BadRequestException("需两个评估批次编号及有效分页");
    return this.history.compare(
      req.params.customerId,
      req.params.softwareId,
      input.data,
    );
  }
  private valid(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.softwareId).success)
      throw new BadRequestException("软件编号无效");
  }
}
for (const method of [
  "get",
  "current",
  "selectCurrent",
  "batch",
  "compare",
] as const)
  Req()(SoftwareHistoryController.prototype, method, 0);
Inject(SoftwareHistoryService)(SoftwareHistoryController, undefined, 0);
@Module({})
export class SoftwareHistoryModule {
  static register(assessments: DynamicModule): DynamicModule {
    return {
      module: SoftwareHistoryModule,
      imports: [SoftwareModule, assessments],
      controllers: [SoftwareHistoryController],
      providers: [
        {
          provide: SoftwareHistoryService,
          inject: [DATABASE, SoftwareService, AssessmentService],
          useFactory: (
            db: Database,
            s: SoftwareService,
            a: AssessmentService,
          ) => new SoftwareHistoryService(db, s, a),
        },
      ],
      exports: [SoftwareHistoryService],
    };
  }
}
