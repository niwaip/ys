import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Input state stays with each assessment type; only its controls move into the
// workspace's shared card. Standalone pages continue to render them inline.
export const ScanConditionsTarget = createContext<
  HTMLElement | null | undefined
>(undefined);

export function ScanConditions({ children }: { children: ReactNode }) {
  const target = useContext(ScanConditionsTarget);
  if (target === undefined) return <>{children}</>;
  return target ? createPortal(children, target) : null;
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
