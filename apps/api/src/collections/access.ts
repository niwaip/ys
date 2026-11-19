import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Post,
  Req,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { AppConfig } from "../config";
import type { Database } from "../persistence/database";
import type { AuthorizedRequest } from "../auth/auth";
import type { CollectionProfile, CollectionTaskInput } from "./pi-collection";
const host = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/);
const key = z
  .string()
  .max(4000)
  .regex(
    /^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+=*(?: [^\r\n]+)?$/,
  );
const credential = z
  .object({
    name: z.string().trim().min(1).max(100),
    privateKey: z
      .string()
      .trim()
      .min(50)
      .max(20000)
      .regex(
        /^-----BEGIN (OPENSSH PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY|PRIVATE KEY)-----[\s\S]+-----END \1-----$/,
      ),
  })
  .strict();
const connection = z
  .object({
    assetId: z.uuid(),
    name: z.string().trim().min(1).max(100),
    credentialId: z.uuid(),
    host,
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/),
    hostKey: key,
    trustConfirmed: z.literal(true),
    allowDocker: z.boolean().default(false),
  })
  .strict();
const fingerprint = (value: string) =>
  "SHA256:" +
  createHash("sha256")
    .update(Buffer.from(value.split(" ")[1], "base64"))
    .digest("base64")
    .replace(/=+$/, "");
export class CollectionAccessService {
  private master?: Promise<Buffer>;
  readonly directory: string;
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {
    this.directory = resolve(
      config.collection?.storeDir ??
        (config.databaseUrl.startsWith("pglite://")
          ? join(config.databaseUrl.slice(9), "access")
          : ".data/access"),
    );
  }
  async cleanInterrupted() {
    await rm(join(this.directory, "jobs"), { recursive: true, force: true });
  }
  private masterKey() {
    return (this.master ??= this.readKey());
  }
  private async readKey() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "master.key");
    try {
      await writeFile(path, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const value = await readFile(path);
    if (value.length !== 32 || ((await stat(path)).mode & 0o077) !== 0)
      throw new ServiceUnavailableException("凭证密钥文件不可用，请检查配置");
    return value;
  }
  async createCredential(
    customerId: string,
    value: z.infer<typeof credential>,
    actor: string,
  ) {
    const id = randomUUID(),
      iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await this.masterKey(), iv);
    cipher.setAAD(Buffer.from(`${customerId}:${id}`));
    const ciphertext = Buffer.concat([
      cipher.update(value.privateKey, "utf8"),
      cipher.final(),
    ]);
    const sealed = {
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    await this.db.query(
      "INSERT INTO access_credentials(id,customer_id,name,sealed,created_by) VALUES($1,$2,$3,$4::jsonb,$5)",
      [id, customerId, value.name, JSON.stringify(sealed), actor],
    );
    return { id, name: value.name, kind: "ssh-key" };
  }
  async credentials(customerId: string) {
    return {
      items: (
        await this.db.query(
          'SELECT id,name,created_at AS "createdAt" FROM access_credentials WHERE customer_id=$1 ORDER BY created_at DESC,id LIMIT 100',
          [customerId],
        )
      ).rows.map((row) => ({ ...row, kind: "ssh-key" })),
    };
  }
  private async target(customerId: string, assetId: string) {
    if (
      !(
        await this.db.query(
          "SELECT id FROM assets WHERE customer_id=$1 AND id=$2",
          [customerId, assetId],
        )
      ).rows.length
    )
      throw new NotFoundException("该客户下未找到目标主机");
  }
  async createConnection(
    customerId: string,
    value: z.infer<typeof connection>,
    actor: string,
  ) {
    await this.target(customerId, value.assetId);
    if (
      !(
        await this.db.query(
          "SELECT id FROM access_credentials WHERE customer_id=$1 AND id=$2",
          [customerId, value.credentialId],
        )
      ).rows.length
    )
      throw new NotFoundException("该客户下未找到登录凭证");
    const id = randomUUID();
    const hostKey = value.hostKey.split(" ").slice(0, 2).join(" ");
    await this.db.query(
      "INSERT INTO asset_connections(id,customer_id,asset_id,credential_id,name,host,port,username,host_key,allow_docker,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        id,
        customerId,
        value.assetId,
        value.credentialId,
        value.name,
        value.host,
        value.port,
        value.username,
        hostKey,
        value.allowDocker,
        actor,
      ],
    );
    return {
      id,
      label: value.name,
      assetId: value.assetId,
      fingerprint: fingerprint(hostKey),
    };
  }
  async list(customerId: string) {
    const rows = (
      await this.db.query(
        'SELECT c.id,c.name AS label,c.asset_id AS "assetId",c.host,c.port,c.username,c.credential_id AS "credentialId",k.name AS "credentialName",c.allow_docker AS "allowDocker",c.host_key AS "hostKey" FROM asset_connections c JOIN access_credentials k ON c.customer_id=k.customer_id AND c.credential_id=k.id WHERE c.customer_id=$1 AND c.active=true ORDER BY c.created_at DESC,c.id LIMIT 100',
        [customerId],
      )
    ).rows;
    return rows.map(({ hostKey, allowDocker, ...row }) => ({
      ...row,
      transport: "ssh",
      fingerprint: fingerprint(String(hostKey)),
      scopes: allowDocker ? ["basic", "container-inventory"] : ["basic"],
    }));
  }
  async disable(customerId: string, id: string) {
    const result = await this.db.query(
      "UPDATE asset_connections SET active=false WHERE customer_id=$1 AND id=$2 RETURNING id",
      [customerId, id],
    );
    if (!result.rows.length) throw new NotFoundException("该客户下未找到连接");
    return { id, active: false };
  }
  async resolve(
    input: CollectionTaskInput,
  ): Promise<{ profile: CollectionProfile; cleanup: () => Promise<void> }> {
    const staticProfile = this.config.collection?.profiles.find(
      (p) =>
        p.id === input.profileId &&
        p.customerId === input.customerId &&
        p.assetId === input.assetId,
    );
    if (staticProfile) {
      if (input.scope === "container-inventory" && !staticProfile.allowDocker)
        throw new ForbiddenException("该连接未授权容器目录访问");
      return { profile: staticProfile, cleanup: async () => {} };
    }
    if (!z.uuid().safeParse(input.profileId).success)
      throw new ForbiddenException("连接未关联当前客户主机");
    const row = (
      await this.db.query(
        "SELECT c.*,k.sealed FROM asset_connections c JOIN access_credentials k ON c.customer_id=k.customer_id AND c.credential_id=k.id WHERE c.customer_id=$1 AND c.id=$2 AND c.asset_id=$3 AND c.active=true",
        [input.customerId, input.profileId, input.assetId],
      )
    ).rows[0];
    if (!row || (input.scope === "container-inventory" && !row.allow_docker))
      throw new ForbiddenException("连接未关联当前客户主机或未授权此采集范围");
    const sealed = row.sealed as {
      iv: string;
      tag: string;
      ciphertext: string;
    };
    const cipher = createDecipheriv(
      "aes-256-gcm",
      await this.masterKey(),
      Buffer.from(sealed.iv, "base64"),
    );
    cipher.setAAD(Buffer.from(`${input.customerId}:${row.credential_id}`));
    cipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const secret = Buffer.concat([
      cipher.update(Buffer.from(sealed.ciphertext, "base64")),
      cipher.final(),
    ]);
    const directory = join(this.directory, "jobs", input.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const identityFile = join(directory, "identity"),
      knownHostsFile = join(directory, "known_hosts");
    const hostname =
      Number(row.port) === 22 ? String(row.host) : `[${row.host}]:${row.port}`;
    try {
      await writeFile(
        identityFile,
        Buffer.concat([secret, Buffer.from("\n")]),
        { mode: 0o600, flag: "wx" },
      );
      await writeFile(knownHostsFile, `${hostname} ${row.host_key}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      secret.fill(0);
    }
    return {
      profile: {
        id: input.profileId,
        label: String(row.name),
        customerId: input.customerId,
        assetId: input.assetId,
        host: String(row.host),
        port: Number(row.port),
        username: String(row.username),
        identityFile,
        knownHostsFile,
        allowDocker: Boolean(row.allow_docker),
      },
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  }
  async authorized(input: CollectionTaskInput) {
    const staticProfile = this.config.collection?.profiles.find(
      (p) =>
        p.id === input.profileId &&
        p.customerId === input.customerId &&
        p.assetId === input.assetId,
    );
    if (staticProfile) {
      if (input.scope === "container-inventory" && !staticProfile.allowDocker)
        throw new ForbiddenException("连接未授权容器目录访问");
      return;
    }
    if (!z.uuid().safeParse(input.profileId).success)
      throw new ForbiddenException("连接未关联当前客户主机");
    const result = await this.db.query(
      "SELECT allow_docker FROM asset_connections WHERE customer_id=$1 AND id=$2 AND asset_id=$3 AND active=true",
      [input.customerId, input.profileId, input.assetId],
    );
    if (
      !result.rows.length ||
      (input.scope === "container-inventory" && !result.rows[0].allow_docker)
    )
      throw new ForbiddenException("连接未关联当前客户主机或未授权此范围");
  }
  async probe(
    customerId: string,
    value: { assetId: string; host: string; port: number },
  ) {
    await this.target(customerId, value.assetId);
    const output = await new Promise<string>((ok, fail) => {
      const child = spawn(
        "/usr/bin/ssh-keyscan",
        ["-t", "ed25519", "-T", "5", "-p", String(value.port), value.host],
        { shell: false, stdio: ["ignore", "pipe", "ignore"] },
      );
      let text = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        fail(new ServiceUnavailableException("读取主机公钥超时"));
      }, 7000);
      child.on("error", () => {
        clearTimeout(timer);
        fail(new ServiceUnavailableException("无法读取主机公钥"));
      });
      child.stdout.on("data", (chunk) => {
        text += chunk.toString();
        if (text.length > 50000) {
          child.kill("SIGKILL");
          clearTimeout(timer);
          fail(new BadRequestException("主机公钥响应超限"));
        }
      });
      child.on("close", () => {
        clearTimeout(timer);
        ok(text);
      });
    });
    const line = output
      .split("\n")
      .map((line) => line.split(/\s+/).slice(1, 3).join(" "))
      .find((line) => key.safeParse(line).success);
    if (!line)
      throw new ServiceUnavailableException(
        "没有取得主机公钥，请检查地址、端口与SSH服务",
      );
    return { hostKey: line, fingerprint: fingerprint(line) };
  }
}
@Controller("api/customers/:customerId/collections")
export class CollectionAccessController {
  constructor(private readonly service: CollectionAccessService) {}
  @Get("credentials") credentials(req: AuthorizedRequest) {
    return this.service.credentials(req.params.customerId);
  }
  @Post("credentials") createCredential(req: AuthorizedRequest) {
    const parsed = credential.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequestException("凭证名称或SSH私钥格式无效");
    return this.service.createCredential(
      req.params.customerId,
      parsed.data,
      req.operator.name,
    );
  }
  @Post("connections") createConnection(req: AuthorizedRequest) {
    const parsed = connection.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequestException(
        "请填写主机、SSH地址、登录凭证并确认主机公钥",
      );
    return this.service.createConnection(
      req.params.customerId,
      parsed.data,
      req.operator.name,
    );
  }
  @Delete("connections/:connectionId") disable(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.connectionId).success)
      throw new BadRequestException("连接编号无效");
    return this.service.disable(req.params.customerId, req.params.connectionId);
  }
  @Post("connections/host-key") probe(req: AuthorizedRequest) {
    const parsed = z
      .object({
        assetId: z.uuid(),
        host,
        port: z.number().int().min(1).max(65535),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      throw new BadRequestException("请填写主机、地址和端口");
    return this.service.probe(req.params.customerId, parsed.data);
  }
}
for (const method of [
  "credentials",
  "createCredential",
  "createConnection",
  "disable",
  "probe",
] as const)
  Req()(CollectionAccessController.prototype, method, 0);
Inject(CollectionAccessService)(CollectionAccessController, undefined, 0);
