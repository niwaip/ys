import { z } from "zod";
const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const configSchema = z
  .object({
    collection: z
      .object({
        storeDir: z.string().min(1).optional(),
        profiles: z
          .array(
            z
              .object({
                transport: z.enum(["ssh", "local"]).optional(),
                id: identity,
                label: z.string().min(1).max(100),
                customerId: identity,
                assetId: z.uuid(),
                host: z
                  .string()
                  .regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/)
                  .or(z.literal(""))
                  .default(""),
                port: z.number().int().min(1).max(65535).optional(),
                username: z
                  .string()
                  .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/)
                  .or(z.literal(""))
                  .default(""),
                knownHostsFile: z
                  .string()
                  .startsWith("/")
                  .or(z.literal(""))
                  .default(""),
                identityFile: z
                  .string()
                  .startsWith("/")
                  .or(z.literal(""))
                  .default(""),
                sshExecutable: z.string().startsWith("/").optional(),
                timeoutMs: z.number().int().min(50).max(300000).optional(),
                allowDocker: z.boolean().default(false),
              })
              .superRefine((p, ctx) => {
                if (
                  p.transport !== "local" &&
                  (!p.host ||
                    !p.username ||
                    !p.knownHostsFile ||
                    !p.identityFile)
                )
                  ctx.addIssue({
                    code: "custom",
                    message: "SSH 连接需要主机、账号、可信主机与密钥路径",
                  });
              }),
          )
          .max(1000),
      })
      .optional(),
    netbox: z
      .object({
        baseUrl: z
          .url()
          .transform((value) => value.replace(/\/+$/, "") + "/")
          .refine(
            (value) =>
              /^https?:\/\//.test(value) &&
              new URL(value).pathname.endsWith("/api/") &&
              !new URL(value).username &&
              !new URL(value).password &&
              !new URL(value).search &&
              !new URL(value).hash,
            "NetBox URL必须指向/api/且不包含凭据、查询或片段",
          ),
        token: z.string().min(1),
        timeoutMs: z.number().int().min(50).max(120000).optional(),
        tenantIds: z.record(z.string(), z.number().int().positive()),
      })
      .optional(),
    pi: z
      .object({
        executable: z.string().min(1).optional(),
        timeoutMs: z.number().int().min(50).max(3600000).optional(),
        scriptPath: z.string().min(1).optional(),
        artifactRoot: z.string().min(1).optional(),
        pythonExecutable: z.string().min(1).optional(),
        provider: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        terminalEvent: z.enum(["agent_settled", "agent_end"]).optional(),
      })
      .optional(),
    trivy: z
      .object({
        executable: z.string().min(1).optional(),
        cacheDir: z.string().min(1).optional(),
        timeoutMs: z.number().int().min(50).max(3600000).optional(),
        maxOutputBytes: z.number().int().min(1000).max(20000000).optional(),
      })
      .optional(),
    databaseUrl: z.string().min(1),
    customers: z
      .array(z.object({ id: identity, name: z.string().min(1) }))
      .min(1),
    operators: z
      .array(
        z.object({
          token: z.string().min(16),
          name: z.string().min(1),
          customerIds: z.array(identity),
        }),
      )
      .min(1),
  })
  .superRefine((config, ctx) => {
    const ids = config.customers.map((c) => c.id);
    if (
      config.collection &&
      (new Set(config.collection.profiles.map((p) => p.id)).size !==
        config.collection.profiles.length ||
        config.collection.profiles.some((p) => !ids.includes(p.customerId)))
    )
      ctx.addIssue({ code: "custom", message: "采集连接引用重复或客户未登记" });
    if (
      config.netbox &&
      (Object.keys(config.netbox.tenantIds).some((id) => !ids.includes(id)) ||
        new Set(Object.values(config.netbox.tenantIds)).size !==
          Object.values(config.netbox.tenantIds).length)
    )
      ctx.addIssue({
        code: "custom",
        message: "NetBox Tenant必须唯一绑定已登记客户",
      });
    if (
      new Set(ids).size !== ids.length ||
      new Set(config.operators.map((o) => o.token)).size !==
        config.operators.length
    )
      ctx.addIssue({ code: "custom", message: "客户或凭据重复" });
    if (
      config.operators.some((o) =>
        o.customerIds.some((id) => !ids.includes(id)),
      )
    )
      ctx.addIssue({ code: "custom", message: "权限引用了不存在的客户" });
  });
export type AppConfig = z.infer<typeof configSchema>;
export function loadConfig(): AppConfig {
  return configSchema.parse({
    collection:
      process.env.YS_COLLECTION_PROFILES || process.env.YS_COLLECTION_STORE
        ? {
            profiles: JSON.parse(process.env.YS_COLLECTION_PROFILES ?? "[]"),
            storeDir: process.env.YS_COLLECTION_STORE,
          }
        : undefined,
    netbox:
      process.env.YS_NETBOX_URL ||
      process.env.YS_NETBOX_TOKEN ||
      process.env.YS_NETBOX_TENANTS
        ? {
            baseUrl: process.env.YS_NETBOX_URL,
            token: process.env.YS_NETBOX_TOKEN,
            tenantIds: JSON.parse(process.env.YS_NETBOX_TENANTS ?? "{}"),
            timeoutMs: process.env.YS_NETBOX_TIMEOUT_MS
              ? Number(process.env.YS_NETBOX_TIMEOUT_MS)
              : undefined,
          }
        : undefined,
    pi: {
      executable: process.env.YS_PI_EXECUTABLE || undefined,
      timeoutMs: process.env.YS_PI_TIMEOUT_MS
        ? Number(process.env.YS_PI_TIMEOUT_MS)
        : undefined,
      scriptPath: process.env.YS_CVE_SCRIPT || undefined,
      artifactRoot: process.env.YS_AGENT_ARTIFACT_ROOT || undefined,
      pythonExecutable: process.env.YS_PYTHON_EXECUTABLE || undefined,
      provider: process.env.YS_PI_PROVIDER || undefined,
      model: process.env.YS_PI_MODEL || undefined,
      terminalEvent: process.env.YS_PI_TERMINAL_EVENT || undefined,
    },
    trivy: {
      executable: process.env.YS_TRIVY_EXECUTABLE,
      cacheDir: process.env.YS_TRIVY_CACHE_DIR,
      timeoutMs: process.env.YS_TRIVY_TIMEOUT_MS
        ? Number(process.env.YS_TRIVY_TIMEOUT_MS)
        : undefined,
    },
    databaseUrl: process.env.DATABASE_URL ?? "pglite://.data/ys",
    customers: JSON.parse(process.env.YS_CUSTOMERS ?? "[]"),
    operators: JSON.parse(process.env.YS_OPERATORS ?? "[]"),
  });
}
