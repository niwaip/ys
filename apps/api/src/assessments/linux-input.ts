import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { HostCollection } from "../../../../packages/contracts/collections";
import type { SoftwareComponent } from "../../../../packages/contracts/software";
export type LinuxPackageInput = {
  format: "dpkg-status/1";
  osRelease: string;
  dpkgStatus: string;
  lsbRelease?: string;
  debianVersion?: string;
};
/** Fixed metadata files only; no client supplied filesystem paths or commands. */
export function linuxInput(row: Record<string, unknown>, assetId: string) {
  if (row.asset_id !== assetId)
    throw new BadRequestException("采集快照不属于所选资产");
  const data = row.normalized as HostCollection;
  const raw = data.extensions.rawSections as
    Record<string, unknown> | undefined;
  const os = data.sections.os?.data as { id?: string; version?: string } | null;
  if (
    data.sections.os?.status !== "acquired" ||
    data.sections.packages?.status !== "acquired" ||
    !os?.id ||
    !["ubuntu", "debian"].includes(os.id) ||
    !os.version
  )
    throw new BadRequestException(
      "当前支持完整取得的Debian/Ubuntu系统包资料；其他发行版尚未接入",
    );
  if (
    typeof raw?.os !== "string" ||
    typeof raw?.dpkgStatus !== "string" ||
    !raw.dpkgStatus.trim()
  )
    throw new BadRequestException(
      "快照缺少原始dpkg数据库，请重新执行基础采集后扫描",
    );
  if (Buffer.byteLength(raw.dpkgStatus) > 4000000)
    throw new BadRequestException("dpkg数据库超出4000000字节限制");
  const release = Object.fromEntries(
    raw.os.split("\n").flatMap((line) => {
      const m = /^([A-Z_]+)=(.*)$/.exec(line);
      return m ? [[m[1], m[2].replace(/^["']|["']$/g, "")]] : [];
    }),
  );
  if (release.ID !== os.id || release.VERSION_ID !== os.version)
    throw new BadRequestException("发行版原始资料与快照不一致");
  if (
    os.id === "ubuntu" &&
    (typeof raw.lsbRelease !== "string" ||
      !raw.lsbRelease.includes("DISTRIB_ID=Ubuntu") ||
      !raw.lsbRelease.includes("DISTRIB_RELEASE=" + os.version))
  )
    throw new BadRequestException(
      "快照缺少一致的Ubuntu发行标识，请重新基础采集",
    );
  if (os.id === "debian" && typeof raw.debianVersion !== "string")
    throw new BadRequestException("快照缺少Debian发行标识，请重新基础采集");
  const components: SoftwareComponent[] = [];
  for (const block of raw.dpkgStatus.split(/\n\s*\n/)) {
    const fields = Object.fromEntries(
      block.split("\n").flatMap((line) => {
        const m = /^([A-Za-z-]+): (.*)$/.exec(line);
        return m ? [[m[1], m[2]]] : [];
      }),
    );
    if (fields.Status !== "install ok installed") continue;
    if (!fields.Package || !fields.Version || !fields.Architecture)
      throw new BadRequestException("原始dpkg记录缺少包名、版本或架构");
    components.push({
      id: `${fields.Package}:${fields.Architecture}`,
      name: fields.Package,
      version: fields.Version,
      ecosystem: "deb",
      purl: null,
      cpe: null,
      bomRef: null,
      parentRef: null,
      issues: [],
      raw: { architecture: fields.Architecture, source: fields.Source ?? null },
    });
  }
  const declared = (
    data.sections.packages.data as {
      manager: string;
      name: string;
      version: string | null;
      architecture: string | null;
      state: string;
    }[]
  ).filter((p) => p.state === "installed");
  const keys = new Set(
    declared.map((p) => `${p.name}|${p.version}|${p.architecture}`),
  );
  if (
    !components.length ||
    new Set(components.map((c) => c.id)).size !== components.length ||
    keys.size !== declared.length ||
    components.length !== declared.length ||
    components.some(
      (c) => !keys.has(`${c.name}|${c.version}|${c.raw.architecture}`),
    ) ||
    declared.some((p) => p.manager !== "dpkg")
  )
    throw new BadRequestException(
      "包清单与原始dpkg数据库不一致，需补采完整资料",
    );
  const content = JSON.stringify({
    format: "dpkg-status/1",
    osRelease: raw.os,
    dpkgStatus: raw.dpkgStatus,
    ...(typeof raw.lsbRelease === "string"
      ? { lsbRelease: raw.lsbRelease }
      : {}),
    ...(typeof raw.debianVersion === "string"
      ? { debianVersion: raw.debianVersion }
      : {}),
  } satisfies LinuxPackageInput);
  return {
    id: String(row.id),
    importId: String(row.id),
    version: os.version,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    snapshotHash: String(row.content_hash),
    components,
    os: { id: os.id, version: os.version },
    collectedAt: data.collectedAt,
  };
}
