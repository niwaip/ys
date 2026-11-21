import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { timingSafeEqual, createHash } from "node:crypto";
import type { AppConfig } from "../config";
export type Operator = AppConfig["operators"][number];
export type AuthorizedRequest = {
  headers: Record<string, string | undefined>;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  operator: Operator;
};
@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(private readonly config: AppConfig) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthorizedRequest>();
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const digest = (s: string) => createHash("sha256").update(s).digest();
    const operator =
      token &&
      this.config.operators.find((o) =>
        timingSafeEqual(digest(o.token), digest(token)),
      );
    if (!operator) throw new UnauthorizedException("请使用有效的操作员凭据");
    req.operator = operator;
    if (
      req.params.customerId &&
      !operator.customerIds.includes(req.params.customerId)
    )
      throw new ForbiddenException("无权访问此客户");
    return true;
  }
}
