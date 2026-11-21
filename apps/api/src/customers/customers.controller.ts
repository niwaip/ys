import { Controller, Get, Req } from "@nestjs/common";
import type { AppConfig } from "../config";
import { type AuthorizedRequest } from "../auth/auth";
@Controller("api")
export class CustomersController {
  constructor(private readonly config: AppConfig) {}
  @Get("customers")
  list(req: AuthorizedRequest) {
    return {
      items: this.config.customers.filter((c) =>
        req.operator.customerIds.includes(c.id),
      ),
      operator: { name: req.operator.name },
    };
  }
}
Req()(CustomersController.prototype, "list", 0);
