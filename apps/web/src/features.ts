import { LifecyclePage } from "./features/lifecycle/LifecyclePage";
import { SoftwarePage } from "./features/software/SoftwarePage";
import { WindowsPage } from "./features/windows/WindowsPage";
import { ImportsPage } from "./features/imports/ImportsPage";
import type { ComponentType } from "react";
import { AssetsPage } from "./features/assets/AssetsPage";
export type FeatureProps = {
  customerId: string;
  token: string;
  onUnauthorized: () => void;
};
export type Feature = {
  id: string;
  label: string;
  icon: string;
  component: ComponentType<FeatureProps>;
};
// Register implemented customer-scoped pages here; the shell owns identity and navigation.
export const features: Feature[] = [
  { id: "assets", label: "资产台账", icon: "▦", component: AssetsPage },
  {
    id: "windows",
    label: "Windows 采集导入",
    icon: "⇧",
    component: WindowsPage,
  },
  { id: "imports", label: "CSV 资料导入", icon: "⇧", component: ImportsPage },
  { id: "lifecycle", label: "EOS/EOL 生命周期", icon: "◷", component: LifecyclePage },
  { id: "software", label: "软件 SBOM", icon: "◇", component: SoftwarePage },
];
