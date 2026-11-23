import { LegacyComponentMaterials } from "./features/collections/LegacyComponentMaterials";
import { LegacyAssetImports } from "./features/imports/LegacyAssetImports";
import { LifecycleRiskPage } from "./features/lifecycle-risk/LifecycleRiskPage";
import {
  CollectionWorkspace,
  AssessmentWorkspace,
  LifecycleMaterials,
  LifecycleEvaluation,
  RiskWorkspace,
} from "./features/workspaces/Workspaces";
import { CollectionsPage } from "./features/collections/CollectionsPage";
import { DashboardPage } from "./features/dashboard/DashboardPage";
import { SoftwareHistoryPage } from "./features/software-history/SoftwareHistoryPage";
import { ConversationsPage } from "./features/conversations/ConversationsPage";
import { WindowsAssessmentsPage } from "./features/windows-assessments/WindowsAssessmentsPage";
import { ContainersPage } from "./features/containers/ContainersPage";
import { AgentPage } from "./features/agent/AgentPage";
import { ReportsPage } from "./features/reports/ReportsPage";
import { AssessmentsPage } from "./features/assessments/AssessmentsPage";
import { LifecyclePage } from "./features/lifecycle/LifecyclePage";
import { SoftwarePage } from "./features/software/SoftwarePage";
import { LegacyWindowsPage } from "./features/windows/WindowsPage";
import { createElement, type ComponentType } from "react";
import { AssetsPage } from "./features/assets/AssetsPage";
export type CollectionContext = {
  snapshotId?: string;
  profileId?: string;
  assetImport?: boolean;
  configurationContent?: "basic" | "docker" | "software";
};
export type FeatureProps = {
  collectionContext?: CollectionContext;
  customerId: string;
  token: string;
  onUnauthorized: () => void;
  assetId?: string;
  onNavigate?: (
    featureId: string,
    assetId?: string,
    context?: CollectionContext,
  ) => void;
};
export type Feature = {
  id: string;
  label: string;
  icon: string;
  component: ComponentType<FeatureProps>;
  group?: string;
  hidden?: boolean;
};
// Register implemented customer-scoped pages here; the shell owns identity and navigation.
const legacyFeatures: Feature[] = [
  { id: "assets", label: "资产台账", icon: "▦", component: AssetsPage },
  {
    id: "collections",
    label: "资产采集",
    icon: "⇩",
    component: CollectionsPage,
  },
  {
    id: "dashboard",
    label: "客户风险概览",
    icon: "◫",
    component: DashboardPage,
  },
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
    id: "customer-chat",
    label: "客户风险对话",
    icon: "◌",
    component: ConversationsPage,
  },
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
    component: LegacyWindowsPage,
  },
  {
    id: "imports",
    label: "CSV 资料导入",
    icon: "⇧",
    component: LegacyAssetImports,
  },
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

const groups: Record<string, string> = {
  dashboard: "总览",
  assets: "资产管理",
  collections: "资产管理",
  software: "资产管理",
  containers: "资产管理",
  "lifecycle-materials": "资产管理",
  "assessment-workspace": "CVE与EOSL评估",
  lifecycle: "CVE与EOSL评估",
  risk: "风险与报告",
  "lifecycle-risk": "风险与报告",
  "software-history": "风险与报告",
  "customer-chat": "风险与报告",
  "public-intelligence": "风险与报告",
  reports: "风险与报告",
};
const replacements: Record<string, Partial<Feature>> = {
  collections: { component: CollectionWorkspace },
  software: {
    component: (props) =>
      createElement(LegacyComponentMaterials, { ...props, kind: "software" }),
  },
  containers: {
    component: (props) =>
      createElement(LegacyComponentMaterials, { ...props, kind: "container" }),
  },
  lifecycle: { component: LifecycleEvaluation, label: "EOSL评估" },
};
const entries: Feature[] = [
  {
    id: "lifecycle-risk",
    label: "生命周期风险",
    icon: "◷",
    component: LifecycleRiskPage,
  },
  ...legacyFeatures.map((f) => ({
    ...f,
    ...replacements[f.id],
    hidden: [
      "software",
      "containers",
      "windows",
      "imports",
      "windows-assessments",
      "assessments",
    ].includes(f.id),
  })),
  {
    id: "lifecycle-materials",
    label: "生命周期资料",
    icon: "◷",
    component: LifecycleMaterials,
  },
  {
    id: "assessment-workspace",
    label: "CVE评估",
    icon: "◈",
    component: AssessmentWorkspace,
  },
  { id: "risk", label: "风险结果", icon: "◫", component: RiskWorkspace },
];
const order = [
  "dashboard",
  "assets",
  "collections",
  "containers",
  "software",
  "lifecycle-materials",
  "assessment-workspace",
  "lifecycle",
  "risk",
  "lifecycle-risk",
  "software-history",
  "customer-chat",
  "public-intelligence",
  "reports",
  "windows",
  "imports",
  "windows-assessments",
  "assessments",
];
export const featureGroups = [
  "总览",
  "资产管理",
  "CVE与EOSL评估",
  "风险与报告",
];
export const features: Feature[] = order.map((id) => ({
  ...entries.find((f) => f.id === id)!,
  group: groups[id],
}));
