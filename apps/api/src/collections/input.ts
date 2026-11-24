import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  hostCollectionSchema,
  type HostCollection,
} from "../../../../packages/contracts/collections";
import { parseCollector } from "../windows/collector";
/** Adapt external collector formats without discarding their original evidence. */
export function parseCollection(content: string): HostCollection {
  let raw: unknown;
  try {
    raw = JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch {
    throw new BadRequestException("采集内容必须为JSON");
  }
  if (raw && typeof raw === "object" && "Hostname" in raw) {
    if (Buffer.byteLength(content) > 500000)
      throw new BadRequestException("Windows JSON最多500000字节");
    const win = parseCollector(content);
    if (win.collectorVersion !== null && win.collectorVersion !== "1")
      throw new BadRequestException("不支持的Windows采集器版本");
    if (!win.serial && !win.targetAssetId)
      throw new ConflictException(
        "Windows资料缺少稳定序列号，身份待确认；请补充资料后重新上传，不按名称合并",
      );
    return hostCollectionSchema.parse({
      schemaVersion: "ys-host/1",
      identity: { hostname: win.hostname, serial: win.serial, machineId: null },
      collectedAt: win.collectedAt,
      sections: {
        os: {
          status: win.os || win.osVersion ? "acquired" : "not_collected",
          data:
            win.os || win.osVersion
              ? {
                  id: win.os,
                  version: win.osVersion,
                  kernel: null,
                  architecture: win.architecture,
                  build: win.fullBuild ?? win.osBuild,
                }
              : null,
        },
      },
      extensions: {
        inputFormat: "windows-bat/1",
        ...(win.targetAssetId ? { targetAssetId: win.targetAssetId } : {}),
        windows: {
          collectorVersion: win.collectorVersion,
          osBuild: win.osBuild,
          fullBuild: win.fullBuild,
          ubr: win.ubr,
          kbInventoryComplete: win.kbInventoryComplete,
          softwareInventoryComplete: win.softwareInventoryComplete,
          rebootPending: win.rebootPending,
          softwareCount: win.software?.length ?? null,
          kbCount: win.kbs?.length ?? null,
        },
      },
    });
  }
  const parsed = hostCollectionSchema.safeParse(raw);
  if (!parsed.success)
    throw new BadRequestException(
      "不支持的采集格式或字段；请使用ys-host/1（设备资料放device区块）或windows-bat/1",
    );
  return parsed.data;
}
