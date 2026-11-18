import { z } from "zod";
const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const configSchema = z
  .object({
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
    databaseUrl: process.env.DATABASE_URL ?? "pglite://.data/ys",
    customers: JSON.parse(process.env.YS_CUSTOMERS ?? "[]"),
    operators: JSON.parse(process.env.YS_OPERATORS ?? "[]"),
  });
}
