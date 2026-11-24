const labels: Record<string, string> = {
  draft: "草稿",
  in_review: "待复核",
  approved: "已通过",
  delivered: "已交付",
  queued: "排队中",
  running: "执行中",
  waiting: "等待资料",
  needs_attention: "需处理",
  interrupted: "已中断",
  cancelled: "已取消",
  completed: "草稿已生成",
  failed: "失败",
  succeeded: "已完成",
  reused: "沿用已有结果",
  pending: "待执行",
  waiting_upload: "等待上传",
  waiting_confirmation: "等待确认",
  ready: "已就绪",
  generating: "生成中",
  complete: "完整",
  partial: "部分可用",
};
export const reportStatus = (value: string) => labels[value] ?? value;
export const reportDate = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export const reportBytes = (value?: number) =>
  value === undefined
    ? ""
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`;
