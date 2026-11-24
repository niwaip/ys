import { z } from "zod";
import { deviceCategory } from "./device-collection";
export const collectionContents = {
  basic: "基础资料",
  docker: "Docker容器",
  software: "软件清单与组件",
} as const;
export const collectionConfiguration = z
  .object({
    category: deviceCategory,
    platform: z.enum(["linux", "windows"]),
    items: z
      .array(
        z
          .object({
            content: z.enum(["basic", "docker", "software"]),
            enabled: z.boolean(),
            method: z.enum(["automatic", "script", "manual"]),
            profileId: z.string().trim().min(1).max(80).optional(),
            softwarePath: z.string().trim().min(1).max(1000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict()
  .superRefine((v, c) => {
    const seen = new Set<string>();
    for (const item of v.items) {
      if (seen.has(item.content))
        c.addIssue({ code: "custom", message: "采集内容不能重复" });
      seen.add(item.content);
      if (!item.enabled) continue;
      const host = ["server", "vm"].includes(v.category);
      if (!host && (item.content !== "basic" || item.method === "automatic"))
        c.addIssue({
          code: "custom",
          message: "此设备仅支持基础资料脚本导入或手动输入",
        });
      if (
        item.method === "automatic" &&
        (v.platform !== "linux" || !item.profileId)
      )
        c.addIssue({
          code: "custom",
          message: "自动采集需要Linux主机及授权连接",
        });
      if (
        item.content === "docker" &&
        (item.method === "manual" || v.platform !== "linux")
      )
        c.addIssue({
          code: "custom",
          message: "容器运行目录需Linux真实连接或脚本采集，不能手动伪造",
        });
    }
  });
export type CollectionConfiguration = z.infer<typeof collectionConfiguration>;
export type ConfigurationContent = keyof typeof collectionContents;
export type ConfigurationRun = {
  id: string;
  assetId: string;
  configuration: CollectionConfiguration;
  createdAt: string;
  items: {
    content: ConfigurationContent;
    status: string;
    jobId?: string;
    snapshotId?: string | null;
    error?: string | null;
  }[];
};
