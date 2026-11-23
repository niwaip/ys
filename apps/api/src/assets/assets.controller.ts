import { deviceCategory } from "../../../../packages/contracts/device-collection";
import { lifecycleAssetSchema } from "../../../../packages/contracts/lifecycle-risk";
import {
  BadRequestException,
  Controller,
  Get,
  Delete,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import { z } from "zod";
import { createAssetSchema } from "../../../../packages/contracts";
import { type AuthorizedRequest } from "../auth/auth";
import { AssetsService } from "./assets.service";
const pagination = z
  .object({
    category: deviceCategory.optional(),
    status: z.enum(["active", "deleted"]).default("active"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(1000000).default(0),
  })
  .strict();
@Controller("api/customers/:customerId/assets")
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}
  @Post()
  create(req: AuthorizedRequest) {
    const input = createAssetSchema.safeParse(req.body);
    if (!input.success)
      throw new BadRequestException(
        "资产信息无效：请检查名称、类型、来源标识和扩展属性",
      );
    return this.assets.create(req.params.customerId, input.data);
  }
  @Get()
  list(req: AuthorizedRequest) {
    const page = pagination.safeParse(req.query);
    if (!page.success) throw new BadRequestException("分页参数无效");
    return this.assets.list(
      req.params.customerId,
      page.data.limit,
      page.data.offset,
      page.data.status,
      page.data.category,
    );
  }
  @Get("summary")
  summary(req: AuthorizedRequest) {
    return this.assets.summary(req.params.customerId);
  }
  private id(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.assetId).success)
      throw new BadRequestException("资产编号无效");
    return req.params.assetId;
  }
  @Delete(":assetId") remove(req: AuthorizedRequest) {
    return this.assets.setDeleted(
      req.params.customerId,
      this.id(req),
      req.operator.name,
      true,
    );
  }
  @Post(":assetId/restore") restore(req: AuthorizedRequest) {
    return this.assets.setDeleted(
      req.params.customerId,
      this.id(req),
      req.operator.name,
      false,
    );
  }
  @Patch(":assetId/classification") classify(req: AuthorizedRequest) {
    const input = z
      .object({ hardwareType: z.enum(["unknown", "server", "network"]) })
      .strict()
      .safeParse(req.body);
    if (!input.success) throw new BadRequestException("硬件分类无效");
    return this.assets.classify(
      req.params.customerId,
      this.id(req),
      input.data.hardwareType,
    );
  }
  @Patch(":assetId/lifecycle") lifecycle(req: AuthorizedRequest) {
    const input = lifecycleAssetSchema.safeParse(req.body);
    if (!input.success) throw new BadRequestException("生命周期资料无效");
    return this.assets.updateLifecycle(
      req.params.customerId,
      this.id(req),
      input.data,
    );
  }
  @Get(":assetId")
  get(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.assetId).success)
      throw new BadRequestException("资产编号无效");
    return this.assets.get(req.params.customerId, req.params.assetId);
  }
}
for (const method of [
  "create",
  "list",
  "summary",
  "get",
  "remove",
  "restore",
  "classify",
  "lifecycle",
] as const)
  Req()(AssetsController.prototype, method, 0);
