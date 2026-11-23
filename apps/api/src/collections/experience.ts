import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Post,
  Req,
} from "@nestjs/common";
import { z } from "zod";
import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { CollectionAccessService } from "./access";
import { CollectionsService } from "./collections.module";
import type { AuthorizedRequest } from "../auth/auth";
const scope = z.enum(["basic", "container-inventory"]);
const target = z
  .object({ assetId: z.uuid(), profileId: z.string().min(1).max(80), scope })
  .strict();
const collectorPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../tools/collection/collect.mjs",
);
@Controller("api/customers/:customerId/collections")
export class CollectionExperienceController {
  constructor(
    private readonly access: CollectionAccessService,
    private readonly collections: CollectionsService,
  ) {}
  @Get("script") async script(req: AuthorizedRequest) {
    const input = z.object({ scope }).strict().safeParse(req.query);
    if (!input.success)
      throw new BadRequestException("请选择基础或容器目录采集范围");
    const source = await readFile(collectorPath, "utf8");
    const selected = input.data.scope;
    return {
      fileName:
        selected === "basic" ? "ys-host-basic.mjs" : "ys-docker-inventory.mjs",
      content:
        source +
        `\nif(process.platform !== 'linux') throw new Error('This collector supports Linux only; Windows/macOS host collection is not supported.');\nconst result=await collect({transport:'local',allowDocker:${selected === "container-inventory"}},'${selected}');\nresult.extensions.execution={scope:'${selected}',method:'offline',transport:'local'};\nconsole.log(JSON.stringify(result));\n`,
    };
  }
  @Post("capabilities") async capabilities(req: AuthorizedRequest) {
    const input = target.safeParse(req.body);
    if (!input.success)
      throw new BadRequestException("主机、连接或采集范围无效");
    await this.collections.assertTarget(
      req.params.customerId,
      input.data.assetId,
    );
    // Resolve basic access so an ungranted Docker capability can be explained without accessing Docker.
    const connection = await this.access.resolve({
      ...input.data,
      scope: "basic",
      customerId: req.params.customerId,
      id: randomUUID(),
      message: "检查采集能力",
    });
    try {
      const module = await import(pathToFileURL(collectorPath).href);
      let checks;
      try {
        checks = await module.probe(connection.profile, input.data.scope);
      } catch {
        checks = {
          hostname:
            connection.profile.transport === "local"
              ? hostname()
              : connection.profile.host,
          identity: null,
          basic: { status: "access_failed" },
          docker: {
            status:
              input.data.scope === "container-inventory" &&
              !connection.profile.allowDocker
                ? "unauthorized"
                : "unchecked",
          },
          trivy: { status: "unchecked" },
        };
      }
      return {
        ...checks,
        assetId: input.data.assetId,
        profileId: input.data.profileId,
        scope: input.data.scope,
        transport: connection.profile.transport ?? "ssh",
        checkedAt: new Date().toISOString(),
      };
    } finally {
      await connection.cleanup();
    }
  }
}
Req()(CollectionExperienceController.prototype, "capabilities", 0);
Req()(CollectionExperienceController.prototype, "script", 0);
Inject(CollectionAccessService)(CollectionExperienceController, undefined, 0);
Inject(CollectionsService)(CollectionExperienceController, undefined, 1);
