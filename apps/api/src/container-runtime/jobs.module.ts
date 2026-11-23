import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  NotFoundException,
  Post,
  Req,
  type DynamicModule,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DATABASE, type Database } from "../persistence/database";
import { requireActiveAsset } from "../assets/asset-state";
import type { AuthorizedRequest } from "../auth/auth";
import { CollectionJobsService } from "../collections/jobs.module";
import { CollectionAccessService } from "../collections/access";
import { AssessmentService } from "../assessments/assessments.module";
import {
  ContainerRuntimeModule,
  ContainerRuntimeService,
} from "./container-runtime.module";
import { DirectImageGenerator, type ImageGenerator } from "./generator";
import {
  imageIdSchema,
  runtimeTerminal,
  type ContainerJob,
} from "../../../../packages/contracts/container-runtime";
const batchInput = z
  .object({
    assetId: z.uuid(),
    profileId: z.string().min(1).max(80),
    snapshotId: z.uuid(),
    imageIds: z.array(imageIdSchema).min(1).max(100),
    idempotencyKey: z.string().min(1).max(100),
  })
  .strict();
type BatchInput = z.infer<typeof batchInput>;
export class ContainerGenerationService {
  private active?: Promise<void>;
  private stopping = false;
  private again = false;
  private abort?: AbortController;
  constructor(
    private db: Database,
    private runtime: ContainerRuntimeService,
    private jobs: CollectionJobsService,
    private access: CollectionAccessService,
    private assessments: AssessmentService,
    private generator: ImageGenerator,
  ) {}
  async onModuleInit() {
    await this.db.query(
      "UPDATE container_generation_jobs SET status='interrupted',details=details||$1::jsonb WHERE status='generating'",
      [
        JSON.stringify({
          status: "interrupted",
          error: "后端重启，生成结果无法确认；请显式重试",
        }),
      ],
    );
    this.wake();
  }
  async onModuleDestroy() {
    this.stopping = true;
    this.abort?.abort();
    await this.active;
  }
  private task(
    customerId: string,
    assetId: string,
    profileId: string,
    id: string,
  ) {
    return {
      id,
      customerId,
      assetId,
      profileId,
      scope: "container-inventory" as const,
      message: "镜像组件采集",
      method: "ssh" as const,
    };
  }
  async discover(
    customer: string,
    input: { assetId: string; profileId: string; idempotencyKey: string },
  ) {
    return this.jobs.submit(customer, {
      ...input,
      method: "ssh",
      scope: "container-inventory",
      message: "发现主机Docker镜像和运行容器",
    });
  }
  async submit(
    customer: string,
    input: BatchInput,
    actor: string,
    resume?: Pick<ContainerJob, "containerId" | "versionId" | "sourceId">,
  ) {
    await this.runtime.collections.assertTarget(customer, input.assetId);
    const inventory = await this.runtime.inventory(customer, input.snapshotId);
    if (inventory.assetId !== input.assetId)
      throw new ConflictException("目录快照属于其他主机");
    const imageIds = [...new Set(input.imageIds)];
    if (imageIds.some((id) => !inventory.items.some((i) => i.imageId === id)))
      throw new BadRequestException("选定镜像不在该目录快照中");
    await this.access.authorized(
      this.task(customer, input.assetId, input.profileId, randomUUID()),
    );
    const saved: ContainerJob[] = [];
    for (const imageId of imageIds) {
      const key = createHash("sha256")
          .update(input.idempotencyKey + ":" + imageId)
          .digest("hex"),
        inputHash = createHash("sha256")
          .update(JSON.stringify({ ...input, imageIds: [imageId], resume }))
          .digest("hex");
      const job = await this.db.transaction(async (tx) => {
        await requireActiveAsset(tx, customer, input.assetId);
        const old = (
          await tx.query(
            "SELECT input_hash,details FROM container_generation_jobs WHERE customer_id=$1 AND idempotency_key=$2",
            [customer, key],
          )
        ).rows[0];
        if (old) {
          if (old.input_hash !== inputHash)
            throw new ConflictException("幂等键已用于其他主机、连接或镜像");
          return old.details as ContainerJob;
        }
        const job: ContainerJob = {
          id: randomUUID(),
          customerId: customer,
          assetId: input.assetId,
          profileId: input.profileId,
          snapshotId: input.snapshotId,
          imageId,
          status: "queued",
          containerId: null,
          versionId: null,
          sourceId: null,
          assessmentId: null,
          error: null,
          createdAt: new Date().toISOString(),
          events: [
            {
              at: new Date().toISOString(),
              message: `${actor} 提交镜像生成并扫描`,
            },
          ],
          ...resume,
        };
        await tx.query(
          "INSERT INTO container_generation_jobs(id,customer_id,asset_id,idempotency_key,input_hash,status,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
          [
            job.id,
            customer,
            job.assetId,
            key,
            inputHash,
            job.status,
            JSON.stringify(job),
          ],
        );
        return job;
      });
      saved.push(job);
    }
    this.wake();
    return { items: saved };
  }
  private async persist(job: ContainerJob) {
    await this.db.query(
      "UPDATE container_generation_jobs SET status=$3,details=$4::jsonb WHERE customer_id=$1 AND id=$2",
      [job.customerId, job.id, job.status, JSON.stringify(job)],
    );
  }
  private wake() {
    if (this.stopping) return;
    if (this.active) {
      this.again = true;
      return;
    }
    this.active = this.drain().finally(() => {
      this.active = undefined;
      if (this.again) {
        this.again = false;
        this.wake();
      }
    });
  }
  private async drain() {
    while (!this.stopping) {
      const row = (
        await this.db.query(
          "SELECT details FROM container_generation_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1",
        )
      ).rows[0];
      if (!row) return;
      const job = row.details as ContainerJob;
      job.status = "generating";
      await this.persist(job);
      this.abort = new AbortController();
      let cleanup = async () => {};
      const timer = setTimeout(() => this.abort?.abort(), 240000);
      try {
        await this.runtime.collections.assertTarget(
          job.customerId,
          job.assetId,
        );
        const resolved = await this.access.resolve(
          this.task(job.customerId, job.assetId, job.profileId, job.id),
        );
        cleanup = resolved.cleanup;
        if (!job.versionId) {
          const generated = await this.generator.generate(
            resolved.profile,
            job.imageId,
            this.abort.signal,
          );
          if (generated.image.imageId !== job.imageId)
            throw new Error("生成的ImageID与选定镜像不一致");
          if (this.abort.signal.aborted)
            throw new Error("镜像生成已超时或中止");
          const inventory = await this.runtime.inventory(
            job.customerId,
            job.snapshotId,
          );
          const selected = inventory.items.find(
            (i) => i.imageId === job.imageId,
          )!;
          const result = await this.runtime.import(
            job.customerId,
            {
              assetId: job.assetId,
              snapshotId: job.snapshotId,
              name: selected.repositories[0] ?? job.imageId,
              fileName: `${job.id}.json`,
              content: JSON.stringify(generated),
            },
            "系统镜像生成",
            "docker_image_observation",
          );
          job.containerId = result.version.containerId;
          job.versionId = result.version.id;
          job.sourceId = result.source.id;
          job.events.push({
            at: new Date().toISOString(),
            message: "SBOM 已生成并保存；开始漏洞评估",
          });
          await this.persist(job);
        }
        const assessment = await this.assessments.submit(job.customerId, {
          containerId: job.containerId!,
          versionId: job.versionId!,
          containerSourceId: job.sourceId!,
          idempotencyKey: `container-generation:${job.id}`,
        });
        job.assessmentId = assessment.id;
        job.status = "assessing";
      } catch (error) {
        job.status = this.stopping
          ? "interrupted"
          : this.abort.signal.aborted
            ? "timed_out"
            : (error as { exitCode?: number }).exitCode === 127
              ? "unavailable"
              : "failed";
        job.error =
          error instanceof ConflictException
            ? error.message
            : "镜像生成失败：请核对连接、Docker访问、目标Trivy及选定镜像是否仍存在；已生成资料会保留，可显式重试";
      } finally {
        clearTimeout(timer);
        await cleanup().catch(() => {
          job.status = "failed";
          job.error = "临时连接资料清理失败，请管理员检查";
        });
        await this.persist(job);
        this.abort = undefined;
      }
    }
  }
  private async synced(job: ContainerJob) {
    if (job.status === "assessing" && job.assessmentId) {
      const row = (
        await this.db.query(
          "SELECT status,details->>'error' AS error FROM vulnerability_jobs WHERE customer_id=$1 AND id=$2",
          [job.customerId, job.assessmentId],
        )
      ).rows[0];
      if (row && runtimeTerminal(String(row.status))) {
        job.status = row.status as ContainerJob["status"];
        job.error = row.error ? String(row.error) : null;
        job.events.push({
          at: new Date().toISOString(),
          message:
            job.status === "succeeded"
              ? "漏洞评估完成"
              : "漏洞评估未成功，SBOM已保留",
        });
        await this.persist(job);
      }
    }
    return job;
  }
  async get(customer: string, id: string) {
    const row = (
      await this.db.query(
        "SELECT details FROM container_generation_jobs WHERE customer_id=$1 AND id=$2",
        [customer, id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("该客户下未找到镜像任务");
    return this.synced(row.details as ContainerJob);
  }
  async list(customer: string, assetId?: string) {
    if (assetId) await this.runtime.collections.assertTarget(customer, assetId);
    const rows = await this.db.query(
      "SELECT details FROM container_generation_jobs WHERE customer_id=$1 AND ($2::uuid IS NULL OR asset_id=$2) ORDER BY created_at DESC,id LIMIT 100",
      [customer, assetId ?? null],
    );
    return {
      items: await Promise.all(
        rows.rows.map((r) => this.synced(r.details as ContainerJob)),
      ),
    };
  }
  async retry(customer: string, id: string, key: string, actor: string) {
    const old = await this.get(customer, id);
    if (!runtimeTerminal(old.status) || old.status === "succeeded")
      throw new ConflictException("仅可重试未成功的终态任务");
    return this.submit(
      customer,
      {
        assetId: old.assetId,
        profileId: old.profileId,
        snapshotId: old.snapshotId,
        imageIds: [old.imageId],
        idempotencyKey: key,
      },
      actor,
      old.versionId
        ? {
            containerId: old.containerId,
            versionId: old.versionId,
            sourceId: old.sourceId,
          }
        : undefined,
    );
  }
}
@Controller("api/customers/:customerId/container-runtime")
class GenerationController {
  constructor(
    private service: ContainerGenerationService,
    private runtime: ContainerRuntimeService,
  ) {}
  @Post("discover") discover(req: AuthorizedRequest) {
    const p = batchInput
      .pick({ assetId: true, profileId: true, idempotencyKey: true })
      .safeParse(req.body);
    if (!p.success) throw new BadRequestException("主机、连接及请求编号无效");
    return this.service.discover(req.params.customerId, p.data);
  }
  @Get("inventory/:snapshotId") inventory(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.snapshotId).success)
      throw new BadRequestException("快照编号无效");
    return this.runtime.inventory(req.params.customerId, req.params.snapshotId);
  }
  @Post("jobs") @HttpCode(202) submit(req: AuthorizedRequest) {
    const p = batchInput.safeParse(req.body);
    if (!p.success)
      throw new BadRequestException("选择主机、目录快照及1–100个镜像");
    return this.service.submit(
      req.params.customerId,
      p.data,
      req.operator.name,
    );
  }
  @Get("jobs") list(req: AuthorizedRequest) {
    const p = z
      .object({ assetId: z.uuid().optional() })
      .strict()
      .safeParse(req.query);
    if (!p.success) throw new BadRequestException("主机参数无效");
    return this.service.list(req.params.customerId, p.data.assetId);
  }
  @Get("jobs/:id") get(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.id).success)
      throw new BadRequestException("任务编号无效");
    return this.service.get(req.params.customerId, req.params.id);
  }
  @Post("jobs/:id/retry") @HttpCode(202) retry(req: AuthorizedRequest) {
    const p = z
      .object({ idempotencyKey: z.string().min(1).max(100) })
      .strict()
      .safeParse(req.body);
    if (!p.success || !z.uuid().safeParse(req.params.id).success)
      throw new BadRequestException("重试资料无效");
    return this.service.retry(
      req.params.customerId,
      req.params.id,
      p.data.idempotencyKey,
      req.operator.name,
    );
  }
  @Get("script") async script() {
    const shell = await readFile(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../tools/collection/image-sbom.sh",
      ),
      "utf8",
    );
    return {
      fileName: "ys-image-sbom.mjs",
      content: `import {execFileSync} from 'node:child_process';\nconst id=process.argv[2];if(!/^sha256:[0-9a-f]{64}$/.test(id??''))throw new Error('Usage: node ys-image-sbom.mjs sha256:FULL_IMAGE_ID > image.json');\nconst raw=execFileSync('/bin/sh',['-s','--',id],{input:Buffer.from('${Buffer.from(shell).toString("base64")}','base64'),timeout:240000,maxBuffer:30000000,encoding:'utf8'});\nconst v={};for(const line of raw.trim().split('\\n')){const [k,b]=line.split('|');v[k]=Buffer.from(b,'base64').toString('utf8').trim();}\nconsole.log(JSON.stringify({schemaVersion:'ys-image/1',host:{hostname:v.YS_HOST,machineId:v.YS_MACHINE||null,serial:v.YS_SERIAL||null},image:JSON.parse(v.YS_IMAGE),toolVersion:v.YS_TOOL,generatedAt:v.YS_TIME,sbom:JSON.parse(v.YS_SBOM)}));\n`,
    };
  }
}
for (const m of [
  "discover",
  "inventory",
  "submit",
  "list",
  "get",
  "retry",
  "script",
] as const)
  Req()(GenerationController.prototype, m, 0);
Inject(ContainerGenerationService)(GenerationController, undefined, 0);
Inject(ContainerRuntimeService)(GenerationController, undefined, 1);
@Module({})
export class ContainerGenerationModule {
  static register(
    collections: DynamicModule,
    assessments: DynamicModule,
    generator?: ImageGenerator,
  ): DynamicModule {
    return {
      module: ContainerGenerationModule,
      imports: [ContainerRuntimeModule, collections, assessments],
      controllers: [GenerationController],
      providers: [
        {
          provide: ContainerGenerationService,
          inject: [
            DATABASE,
            ContainerRuntimeService,
            CollectionJobsService,
            CollectionAccessService,
            AssessmentService,
          ],
          useFactory: (
            db: Database,
            runtime: ContainerRuntimeService,
            jobs: CollectionJobsService,
            access: CollectionAccessService,
            assess: AssessmentService,
          ) =>
            new ContainerGenerationService(
              db,
              runtime,
              jobs,
              access,
              assess,
              generator ?? new DirectImageGenerator(),
            ),
        },
      ],
    };
  }
}
