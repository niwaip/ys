import { z } from "zod";

export const reportPresentation = z
  .object({
    topic: z
      .enum(["combined", "vulnerability", "lifecycle"])
      .default("combined"),
    optionalChapters: z
      .array(z.enum(["summary", "overview", "recommendations"]))
      .refine((items) => new Set(items).size === items.length)
      .default(["summary", "overview", "recommendations"]),
  })
  .strict();
export type ReportPresentation = z.infer<typeof reportPresentation>;
