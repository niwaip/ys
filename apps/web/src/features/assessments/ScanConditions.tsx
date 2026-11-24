import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Input state stays with each assessment type; only its controls move into the
// workspace's shared card. Standalone pages continue to render them inline.
export const ScanConditionsTarget = createContext<
  HTMLElement | null | undefined
>(undefined);

export function ScanConditions({
  children,
  trivy = false,
}: {
  children: ReactNode;
  trivy?: boolean;
}) {
  const content = (
    <>
      {children}
      {trivy && (
        <p className="subtle">
          扫描前自动检查并更新 Trivy
          漏洞数据库；更新成功后开始扫描，失败则停止。
        </p>
      )}
    </>
  );
  const target = useContext(ScanConditionsTarget);
  if (target === undefined) return content;
  return target ? createPortal(content, target) : null;
}

export function ScanConditionsHeading({
  children,
  standaloneLevel = 2,
}: {
  children: ReactNode;
  standaloneLevel?: 1 | 2;
}) {
  const target = useContext(ScanConditionsTarget);
  const Heading =
    target !== undefined ? "h3" : standaloneLevel === 1 ? "h1" : "h2";
  return <Heading>{children}</Heading>;
}
