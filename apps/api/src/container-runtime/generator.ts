import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CollectionProfile } from "../collections/pi-collection";
import {
  generatedImageSchema,
  imageIdSchema,
  type GeneratedImage,
} from "../../../../packages/contracts/container-runtime";
export interface ImageGenerator {
  generate(
    profile: CollectionProfile,
    imageId: string,
    signal: AbortSignal,
  ): Promise<GeneratedImage>;
}
export class DirectImageGenerator implements ImageGenerator {
  async generate(
    profile: CollectionProfile,
    imageId: string,
    signal: AbortSignal,
  ) {
    imageIdSchema.parse(imageId);
    if (!profile.allowDocker) throw new Error("连接未授权Docker访问");
    const script = await readFile(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../tools/collection/image-sbom.sh",
      ),
      "utf8",
    );
    const { execute } = await import(
      pathToFileURL(
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../../../../tools/collection/collect.mjs",
        ),
      ).href
    );
    const raw = await execute(
      profile,
      `set -- '${imageId}'\n${script}`,
      signal,
      30000000,
    );
    const values: Record<string, string> = {};
    for (const line of raw.trim().split("\n")) {
      const [key, b64, ...rest] = line.split("|");
      if (
        rest.length ||
        !/^YS_[A-Z]+$/.test(key) ||
        values[key] !== undefined ||
        b64 === undefined
      )
        throw new Error("镜像生成协议无效");
      values[key] = Buffer.from(b64, "base64").toString("utf8").trim();
    }
    const image = JSON.parse(values.YS_IMAGE);
    image.repoTags ??= [];
    image.repoDigests ??= [];
    return generatedImageSchema.parse({
      schemaVersion: "ys-image/1",
      host: {
        hostname: values.YS_HOST,
        machineId: values.YS_MACHINE || null,
        serial: values.YS_SERIAL || null,
      },
      image,
      generatedAt: values.YS_TIME,
      toolVersion: values.YS_TOOL,
      sbom: JSON.parse(values.YS_SBOM),
    });
  }
}
