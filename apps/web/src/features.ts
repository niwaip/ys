import { SoftwarePage } from "./features/software/SoftwarePage";
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
  { id: "imports", label: "CSV 资料导入", icon: "⇧", component: ImportsPage },
  { id: "software", label: "软件 SBOM", icon: "◇", component: SoftwarePage },
];
