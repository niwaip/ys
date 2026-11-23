import { z } from "zod";
export const deviceCategories = {
  server: "物理服务器",
  vm: "虚拟机",
  network: "网络 / 安全设备",
  storage: "存储设备",
  power: "电源设备",
  other: "其他设备",
} as const;
export const deviceCategory = z.enum([
  "server",
  "vm",
  "network",
  "storage",
  "power",
  "other",
]);
export type DeviceCategory = z.infer<typeof deviceCategory>;
const text = z.string().trim().min(1).max(2000).nullable().optional();
export const deviceFacts = z
  .object({
    category: deviceCategory,
    manufacturer: text,
    model: text,
    firmware: text,
    modules: text,
    controller: text,
    cpu: text,
    memory: text,
    disks: text,
    software: text,
    supportUntil: z.iso.date().nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const restricted = Object.keys(deviceFieldLabels).filter(
      (field) =>
        !deviceFields(v.category).includes(
          field as keyof typeof deviceFieldLabels,
        ),
    );
    for (const field of restricted)
      if (v[field as keyof typeof v] != null)
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "该资料不适用于所选设备类型",
        });
    if (
      !Object.entries(v).some(([k, value]) => k !== "category" && value != null)
    )
      ctx.addIssue({ code: "custom", message: "至少填写一项设备资料" });
  });
export type DeviceFacts = z.infer<typeof deviceFacts>;
export const deviceFieldLabels: Record<
  Exclude<keyof DeviceFacts, "category">,
  string
> = {
  manufacturer: "厂家",
  model: "型号",
  firmware: "系统 / 固件版本",
  modules: "模块资料",
  controller: "控制器资料",
  cpu: "CPU / 虚拟CPU",
  memory: "内存",
  disks: "磁盘 / 虚拟磁盘",
  software: "软件及版本",
  supportUntil: "支持终止日期",
};
export function deviceFields(category: DeviceCategory) {
  const all =
    category === "vm"
      ? ["cpu", "memory", "disks", "software", "supportUntil"]
      : category === "server"
        ? [
            "manufacturer",
            "model",
            "firmware",
            "cpu",
            "memory",
            "disks",
            "software",
            "modules",
            "supportUntil",
          ]
        : category === "storage"
          ? [
              "manufacturer",
              "model",
              "firmware",
              "controller",
              "modules",
              "supportUntil",
            ]
          : ["manufacturer", "model", "firmware", "modules", "supportUntil"];
  return all as (keyof typeof deviceFieldLabels)[];
}
