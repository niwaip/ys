import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Req,
} from "@nestjs/common";
import { z } from "zod";
import { createAssetSchema } from "../../../../packages/contracts";
import { type AuthorizedRequest } from "../auth/auth";
import { AssetsService } from "./assets.service";
const pagination = z
  .object({
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
    );
  }
  @Get(":assetId")
  get(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.assetId).success)
      throw new BadRequestException("资产编号无效");
    return this.assets.get(req.params.customerId, req.params.assetId);
  }
}
for (const method of ["create", "list", "get"] as const)
  Req()(AssetsController.prototype, method, 0);
