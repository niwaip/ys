import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Global,
  Inject,
  Module,
  NotFoundException,
  Post,
  Patch,
  Req,
  ServiceUnavailableException,
  type DynamicModule,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config";
import { DATABASE, type Database } from "../persistence/database";
import type { AuthorizedRequest } from "../auth/auth";
async function boundedJson(response: Response) {
  if (!response.body) throw new Error("empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 5000000) {
        await reader.cancel();
        throw new Error("size");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}
const objectType = z.enum(["device", "virtual-machine"]);
const writeAsset = z
  .object({
    idempotencyKey: z.string().min(1).max(100),
    objectType,
    name: z.string().trim().min(1).max(200),
    serial: z.string().max(200).optional(),
    deviceType: z.number().int().positive().optional(),
    role: z.number().int().positive().optional(),
    site: z.number().int().positive().optional(),
    cluster: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.objectType === "device" &&
      (!value.deviceType || !value.role || !value.site)
    )
      ctx.addIssue({
        code: "custom",
        message: "Device须填写deviceType、role、site",
      });
    if (value.objectType === "virtual-machine" && !value.site && !value.cluster)
      ctx.addIssue({ code: "custom", message: "VM须填写site或cluster" });
    if (
      value.objectType === "virtual-machine" &&
      (value.deviceType || value.role)
    )
      ctx.addIssue({ code: "custom", message: "VM不支持设备类型和设备角色" });
    if (value.objectType === "device" && value.cluster)
      ctx.addIssue({ code: "custom", message: "Device不支持cluster" });
  });
const nativeAsset = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  tenant: z.object({ id: z.number().int().positive() }).nullable(),
  serial: z.string().optional(),
  asset_tag: z.string().nullable().optional(),
  platform: z
    .object({ id: z.number(), name: z.string() })
    .nullable()
    .optional(),
  primary_ip4: z.object({ address: z.string() }).nullable().optional(),
  primary_ip6: z.object({ address: z.string() }).nullable().optional(),
});
type NativeAsset = z.infer<typeof nativeAsset>;
const paths = {
  device: "dcim/devices/",
  "virtual-machine": "virtualization/virtual-machines/",
};
const page = z.object({
  count: z.number().int().nonnegative().max(100000),
  next: z.string().nullable(),
  results: z.array(nativeAsset),
});
export class NetBoxService {
  constructor(
    private readonly db: Database,
    private readonly config?: AppConfig["netbox"],
  ) {}
  get enabled() {
    return Boolean(this.config);
  }
  acceptsMapping(customerId: string, mapping: Record<string, unknown>) {
    return (
      mapping.instance === this.config?.baseUrl &&
      Number(mapping.tenant_id) === this.config?.tenantIds[customerId]
    );
  }
  status(customerId: string) {
    return {
      mode: this.enabled ? "netbox" : "legacy",
      configured: this.enabled,
      tenantId: this.config?.tenantIds[customerId] ?? null,
    };
  }
  private tenant(customerId: string) {
    const id = this.config?.tenantIds[customerId];
    if (!this.config || !id)
      throw new ServiceUnavailableException(
        "该客户尚未配置NetBox Tenant；没有切换为本地写入",
      );
    return id;
  }
  private async read(path: string): Promise<unknown> {
    const config = this.config!;
    const url = new URL(path, config.baseUrl);
    const base = new URL(config.baseUrl);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
      throw new BadGatewayException("NetBox分页地址超出配置范围");
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Token ${config.token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(config.timeoutMs ?? 15000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("remote");
      return await boundedJson(response);
    } catch {
      throw new BadGatewayException(
        "无法读取NetBox，请检查连接、权限与响应格式；本地缓存未视为最新",
      );
    }
  }
  private validate(raw: unknown, tenantId: number): NativeAsset {
    const parsed = nativeAsset.safeParse(raw);
    if (!parsed.success || parsed.data.tenant?.id !== tenantId)
      throw new BadGatewayException("NetBox资产格式或Tenant归属不匹配");
    return parsed.data;
  }
  private async all(type: z.infer<typeof objectType>, tenantId: number) {
    let next: string | null =
      `${paths[type]}?tenant_id=${tenantId}&limit=100&offset=0`;
    const seen = new Set<string>();
    const results: NativeAsset[] = [];
    const ids = new Set<number>();
    while (next) {
      if (seen.has(next) || seen.size >= 1000)
        throw new BadGatewayException("NetBox分页重复或超过100000项边界");
      seen.add(next);
      const parsed = page.safeParse(await this.read(next));
      if (!parsed.success)
        throw new BadGatewayException("NetBox列表格式不兼容");
      for (const row of parsed.data.results) {
        if (results.length >= 100000)
          throw new BadGatewayException("NetBox资产超过100000项同步边界");
        if (ids.has(row.id))
          throw new BadGatewayException("NetBox分页含重复对象，请重试同步");
        ids.add(row.id);
        results.push(this.validate(row, tenantId));
      }
      next = parsed.data.next;
      if (!next && results.length !== parsed.data.count)
        throw new BadGatewayException("NetBox分页不完整；请重试同步");
    }
    return results;
  }
  private async cache(
    session: Database | Parameters<Parameters<Database["transaction"]>[0]>[0],
    customerId: string,
    type: z.infer<typeof objectType>,
    row: NativeAsset,
    localId?: string,
  ) {
    const instance = this.config!.baseUrl;
    const existing = await session.query(
      "SELECT asset_id FROM netbox_assets WHERE instance=$1 AND object_type=$2 AND external_id=$3",
      [instance, type, row.id],
    );
    const mapped = existing.rows[0]?.asset_id as string | undefined;
    if (mapped && localId && mapped !== localId)
      throw new ConflictException("该NetBox对象已映射其他资产，不能合并历史");
    const id = mapped ?? localId ?? randomUUID();
    const prior = await session.query(
      "SELECT instance,object_type,external_id FROM netbox_assets WHERE asset_id=$1",
      [id],
    );
    if (
      prior.rows.length &&
      (prior.rows[0].instance !== instance ||
        prior.rows[0].object_type !== type ||
        Number(prior.rows[0].external_id) !== row.id)
    )
      throw new ConflictException("历史资产已有其他NetBox映射，不能替换");
    const owner = await session.query(
      "SELECT customer_id FROM assets WHERE id=$1",
      [id],
    );
    if (owner.rows.length && owner.rows[0].customer_id !== customerId)
      throw new ConflictException(
        "NetBox资产已有其他客户映射，请先解决Tenant变更",
      );
    const attributes = {
      netbox: {
        objectType: type,
        id: row.id,
        tenantId: row.tenant!.id,
        instance,
        syncedAt: new Date().toISOString(),
      },
      serial: row.serial ?? null,
      assetTag: row.asset_tag ?? null,
      platform: row.platform ?? null,
      primaryIp4: row.primary_ip4?.address ?? null,
      primaryIp6: row.primary_ip6?.address ?? null,
    };
    await session.query(
      "INSERT INTO assets(id,customer_id,name,kind,source,source_ref,attributes) VALUES($1,$2,$3,'host','netbox',$4,$5::jsonb) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,source='netbox',attributes=EXCLUDED.attributes",
      [
        id,
        customerId,
        row.name,
        `${type}:${row.id}`,
        JSON.stringify(attributes),
      ],
    );
    await session.query(
      "INSERT INTO netbox_assets(customer_id,asset_id,instance,object_type,external_id,tenant_id,synced_at,active) VALUES($1,$2,$3,$4,$5,$6,now(),true) ON CONFLICT(asset_id) DO UPDATE SET synced_at=now(),active=true",
      [customerId, id, instance, type, row.id, row.tenant!.id],
    );
    return { assetId: id, objectType: type, externalId: row.id };
  }
  async sync(customerId: string) {
    const tenantId = this.tenant(customerId);
    // Fetch and validate both lists before changing any cached records.
    const devices = await this.all("device", tenantId);
    const vms = await this.all("virtual-machine", tenantId);
    return this.db.transaction(async (session) => {
      await session.query(
        "UPDATE netbox_assets SET active=false WHERE customer_id=$1 AND instance=$2",
        [customerId, this.config!.baseUrl],
      );
      const items = [];
      for (const row of devices)
        items.push(await this.cache(session, customerId, "device", row));
      for (const row of vms)
        items.push(
          await this.cache(session, customerId, "virtual-machine", row),
        );
      return { items, total: items.length, syncedAt: new Date().toISOString() };
    });
  }
  async create(
    customerId: string,
    input: z.infer<typeof writeAsset>,
    update?: { assetId: string; externalId: number },
  ) {
    const tenantId = this.tenant(customerId);
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          instance: this.config!.baseUrl,
          tenantId,
          ...input,
          update,
        }),
      )
      .digest("hex");
    const id = randomUUID();
    const claim = await this.db.query(
      "INSERT INTO netbox_operations(id,customer_id,idempotency_key,input_hash,status,input) VALUES($1,$2,$3,$4,'pending',$5::jsonb) ON CONFLICT(customer_id,idempotency_key) DO NOTHING RETURNING id",
      [id, customerId, input.idempotencyKey, hash, JSON.stringify(input)],
    );
    if (!claim.rows.length) {
      const old = (
        await this.db.query(
          "SELECT input_hash,status,result FROM netbox_operations WHERE customer_id=$1 AND idempotency_key=$2",
          [customerId, input.idempotencyKey],
        )
      ).rows[0];
      if (old.input_hash !== hash)
        throw new ConflictException("幂等键对应不同建档内容或NetBox配置");
      if (old.status === "succeeded")
        return { ...(old.result as object), replayed: true };
      throw new ConflictException(
        "NetBox写入未确认成功；请核对远端对象及操作记录，不自动重试创建",
      );
    }
    try {
      const body = {
        name: input.name,
        tenant: tenantId,
        ...(update ? {} : { status: "active" }),
        ...(input.serial !== undefined ? { serial: input.serial } : {}),
        ...(input.deviceType ? { device_type: input.deviceType } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.site ? { site: input.site } : {}),
        ...(input.cluster ? { cluster: input.cluster } : {}),
      };
      const response = await fetch(
        new URL(
          paths[input.objectType] + (update ? `${update.externalId}/` : ""),
          this.config!.baseUrl,
        ),
        {
          method: update ? "PATCH" : "POST",
          headers: {
            Authorization: `Token ${this.config!.token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config!.timeoutMs ?? 15000),
          redirect: "error",
        },
      );
      if (!response.ok) throw new Error("remote");
      const native = this.validate(await boundedJson(response), tenantId);
      if (
        native.name !== input.name ||
        (input.serial !== undefined && native.serial !== input.serial)
      )
        throw new Error("identity");
      const result = await this.db.transaction(async (session) => {
        const cached = await this.cache(
          session,
          customerId,
          input.objectType,
          native,
          update?.assetId,
        );
        const result = { ...cached, operationId: id };
        await session.query(
          "UPDATE netbox_operations SET status='succeeded',result=$2::jsonb WHERE id=$1",
          [id, JSON.stringify(result)],
        );
        return result;
      });
      return result;
    } catch {
      await this.db.query(
        "UPDATE netbox_operations SET status='unknown' WHERE id=$1 AND status='pending'",
        [id],
      );
      throw new BadGatewayException(
        `NetBox写入未获确认，操作编号${id}；远端可能已写入，请核对后同步或显式映射，禁止自动重复写入`,
      );
    }
  }
  async update(
    customerId: string,
    assetId: string,
    input: { idempotencyKey: string; name: string; serial?: string },
  ) {
    this.tenant(customerId);
    const mapping = (
      await this.db.query(
        "SELECT object_type,external_id FROM netbox_assets WHERE customer_id=$1 AND asset_id=$2 AND instance=$3 AND active=true",
        [customerId, assetId, this.config!.baseUrl],
      )
    ).rows[0];
    if (!mapping) throw new NotFoundException("该客户下未找到当前NetBox映射");
    await this.resolveReference(
      customerId,
      `${mapping.object_type}:${mapping.external_id}`,
    );
    return this.create(
      customerId,
      {
        ...input,
        objectType: mapping.object_type as z.infer<typeof objectType>,
      },
      { assetId, externalId: Number(mapping.external_id) },
    );
  }
  async operations(customerId: string) {
    return {
      items: (
        await this.db.query(
          'SELECT id,status,input,result,created_at AS "createdAt" FROM netbox_operations WHERE customer_id=$1 ORDER BY created_at DESC,id LIMIT 100',
          [customerId],
        )
      ).rows,
    };
  }
  async resolveReference(customerId: string, reference: string) {
    const match = /^(device|virtual-machine):([1-9][0-9]*)$/.exec(reference);
    if (!match)
      throw new ConflictException(
        "NetBox模式的CSV sourceRef须填写device:ID或virtual-machine:ID；请先建档同步",
      );
    const type = match[1] as z.infer<typeof objectType>;
    const id = Number(match[2]);
    const tenantId = this.tenant(customerId);
    const row = this.validate(
      await this.read(`${paths[type]}${id}/`),
      tenantId,
    );
    if (row.id !== id) throw new BadGatewayException("NetBox详情身份不匹配");
    const found = await this.db.query(
      "SELECT asset_id FROM netbox_assets WHERE customer_id=$1 AND instance=$2 AND object_type=$3 AND external_id=$4 AND active=true",
      [customerId, this.config!.baseUrl, type, id],
    );
    if (found.rows.length !== 1)
      throw new ConflictException("该NetBox资产尚未同步或映射至当前客户");
    return String(found.rows[0].asset_id);
  }
  async resolveSerial(customerId: string, serial: string | null) {
    this.tenant(customerId);
    if (!serial) return null;
    const found = await this.db.query(
      "SELECT n.asset_id,n.object_type,n.external_id FROM netbox_assets n JOIN assets a ON a.id=n.asset_id WHERE n.customer_id=$1 AND n.instance=$2 AND n.active=true AND a.attributes->>'serial'=$3",
      [customerId, this.config!.baseUrl, serial],
    );
    if (found.rows.length !== 1) return null;
    const row = found.rows[0];
    const native = this.validate(
      await this.read(
        `${paths[row.object_type as keyof typeof paths]}${row.external_id}/`,
      ),
      this.tenant(customerId),
    );
    if (native.serial !== serial || native.id !== Number(row.external_id))
      throw new ConflictException("NetBox序列号或对象身份已变更，请重新同步");
    return String(row.asset_id);
  }
  async mappings(customerId: string) {
    const result = await this.db.query(
      'SELECT a.id AS "assetId",a.name,n.object_type AS "objectType",n.external_id AS "externalId",n.tenant_id AS "tenantId",n.synced_at AS "syncedAt",n.active FROM assets a LEFT JOIN netbox_assets n ON n.asset_id=a.id WHERE a.customer_id=$1 ORDER BY a.created_at DESC,a.id LIMIT 100',
      [customerId],
    );
    return { items: result.rows };
  }
  async map(
    customerId: string,
    input: {
      assetId: string;
      objectType: z.infer<typeof objectType>;
      externalId: number;
    },
  ) {
    const tenantId = this.tenant(customerId);
    const local = await this.db.query(
      "SELECT id FROM assets WHERE customer_id=$1 AND id=$2",
      [customerId, input.assetId],
    );
    if (!local.rows.length)
      throw new NotFoundException("该客户下未找到历史资产");
    const current = await this.db.query(
      "SELECT instance,object_type,external_id FROM netbox_assets WHERE asset_id=$1",
      [input.assetId],
    );
    if (
      current.rows.length &&
      (current.rows[0].instance !== this.config!.baseUrl ||
        current.rows[0].object_type !== input.objectType ||
        Number(current.rows[0].external_id) !== input.externalId)
    )
      throw new ConflictException("资产已有不同NetBox身份，不能替换历史映射");
    const row = this.validate(
      await this.read(`${paths[input.objectType]}${input.externalId}/`),
      tenantId,
    );
    if (row.id !== input.externalId)
      throw new BadGatewayException("NetBox详情身份不匹配");
    return this.db.transaction((session) =>
      this.cache(session, customerId, input.objectType, row, input.assetId),
    );
  }
}
@Controller("api/customers/:customerId/netbox")
export class NetBoxController {
  constructor(private readonly service: NetBoxService) {}
  @Patch("assets/:assetId") update(req: AuthorizedRequest) {
    const input = z
      .object({
        idempotencyKey: z.string().min(1).max(100),
        name: z.string().trim().min(1).max(200),
        serial: z.string().max(200).optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!input.success || !z.uuid().safeParse(req.params.assetId).success)
      throw new BadRequestException("资产修改输入无效");
    return this.service.update(
      req.params.customerId,
      req.params.assetId,
      input.data,
    );
  }
  @Post("assets") create(req: AuthorizedRequest) {
    const input = writeAsset.safeParse(req.body);
    if (!input.success)
      throw new BadRequestException(
        "NetBox原生建档字段无效，请核对Device的类型、角色、站点或VM的站点/集群",
      );
    return this.service.create(req.params.customerId, input.data);
  }
  @Get("operations") operations(req: AuthorizedRequest) {
    return this.service.operations(req.params.customerId);
  }
  @Get("status") status(req: AuthorizedRequest) {
    return this.service.status(req.params.customerId);
  }
  @Get("mappings") mappings(req: AuthorizedRequest) {
    return this.service.mappings(req.params.customerId);
  }
  @Post("sync") sync(req: AuthorizedRequest) {
    if (!z.object({}).strict().safeParse(req.body).success)
      throw new BadRequestException("同步请求无效");
    return this.service.sync(req.params.customerId);
  }
  @Post("mappings") map(req: AuthorizedRequest) {
    const input = z
      .object({
        assetId: z.uuid(),
        objectType,
        externalId: z.number().int().positive(),
      })
      .strict()
      .safeParse(req.body);
    if (!input.success) throw new BadRequestException("映射输入无效");
    return this.service.map(req.params.customerId, input.data);
  }
}
for (const method of [
  "status",
  "mappings",
  "sync",
  "map",
  "create",
  "operations",
  "update",
] as const)
  Req()(NetBoxController.prototype, method, 0);
Inject(NetBoxService)(NetBoxController, undefined, 0);
@Global()
@Module({})
export class NetBoxModule {
  static register(config?: AppConfig["netbox"]): DynamicModule {
    return {
      module: NetBoxModule,
      controllers: [NetBoxController],
      providers: [
        {
          provide: NetBoxService,
          inject: [DATABASE],
          useFactory: (db: Database) => new NetBoxService(db, config),
        },
      ],
      exports: [NetBoxService],
    };
  }
}
