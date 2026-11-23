import type { DeviceCategory } from "../../../../../packages/contracts/device-collection";
export function categoryForAsset(
  asset: { hardwareType?: string; attributes: Record<string, unknown> },
  mappings: Record<string, DeviceCategory> = {},
): DeviceCategory {
  const attrs = asset.attributes;
  if (
    (attrs.netbox as { objectType?: string } | undefined)?.objectType ===
    "virtual-machine"
  )
    return "vm";
  const role = attrs.role as
    { id?: number; slug?: string; name?: string } | undefined;
  if (role?.id && mappings[String(role.id)]) return mappings[String(role.id)];
  const value = `${role?.slug ?? ""} ${role?.name ?? ""}`.toLowerCase();
  if (/switch|router|firewall|network|交换|路由|防火墙|网络/.test(value))
    return "network";
  if (/storage|san|nas|存储/.test(value)) return "storage";
  if (/power|pdu|ups|电源/.test(value)) return "power";
  if (/server|服务器/.test(value)) return "server";
  return asset.hardwareType === "server"
    ? "server"
    : asset.hardwareType === "network"
      ? "network"
      : "other";
}
