import { SoftwareHistoryPage } from "./features/software-history/SoftwareHistoryPage";
import { ContainersPage } from "./features/containers/ContainersPage";
import { AgentPage } from "./features/agent/AgentPage";
import { ReportsPage } from "./features/reports/ReportsPage";
import { WindowsAssessmentsPage } from "./features/windows-assessments/WindowsAssessmentsPage";
import { AssessmentsPage } from "./features/assessments/AssessmentsPage";
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
    id: "software-history",
    label: "历史与比较",
    icon: "⇄",
    component: SoftwareHistoryPage,
  },
  {
    id: "windows-assessments",
    label: "Windows 补丁评估",
    icon: "◈",
    component: WindowsAssessmentsPage,
  },
  { id: "containers", label: "容器镜像", icon: "⬡", component: ContainersPage },
  {
    id: "public-intelligence",
    label: "公开 CVE 对话",
    icon: "◌",
    component: AgentPage,
  },
  {
    id: "windows",
    label: "Windows 采集导入",
    icon: "⇧",
    component: WindowsPage,
  },
  { id: "imports", label: "CSV 资料导入", icon: "⇧", component: ImportsPage },
  {
    id: "lifecycle",
    label: "EOS/EOL 生命周期",
    icon: "◷",
    component: LifecyclePage,
  },
  { id: "software", label: "软件 SBOM", icon: "◇", component: SoftwarePage },
  { id: "reports", label: "风险事实报告", icon: "▤", component: ReportsPage },
  {
    id: "assessments",
    label: "软件漏洞评估",
    icon: "◈",
    component: AssessmentsPage,
  },
];
