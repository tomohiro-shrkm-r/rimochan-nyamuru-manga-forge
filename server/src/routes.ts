import { createRoute, z } from "@hono/zod-openapi";
import { LIMITS } from "./config.js";

const binary = (description: string) =>
  z.instanceof(File).openapi({ type: "string", format: "binary", description });

export const ErrorSchema = z
  .object({ error: z.string() })
  .openapi("Error");

const JobId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "不正な job id")
  .openapi({ example: "d735158a-5a1f-4944-a8c3-6223768dec93" });

const StatusSchema = z.enum(["queued", "running", "done", "failed"]);

export const StyleSchema = z
  .object({
    id: z.string().openapi({ example: "crayon", description: "style に渡す名前" }),
    name: z.string().openapi({ example: "クレヨン" }),
  })
  .openapi("Style");

export const CreateJobForm = z.object({
  omny: z
    .union(
      [
        z.string().min(1, "OMNY（YAML本文またはファイル）は必須"),
        binary("OMNY（YAML）ファイル"),
      ],
      { error: "OMNY（YAML本文またはファイル）は必須" },
    )
    .openapi({
      description: "OMNY（漫画ネームYAML）。本文の文字列でもファイルでも可",
    }),
  style: z.string().optional().openapi({
    description: "画風 id（GET /styles の id）",
    example: "crayon",
  }),
  memo: z.string().max(LIMITS.memoChars).optional().openapi({
    description: `作品固有の追加指示（${LIMITS.memoChars}文字まで）`,
  }),
  pages: z.coerce.number().int().min(1).max(LIMITS.maxPages).optional().openapi({
    description: `ページ数。省略時は OMNY の meta.page_count（1〜${LIMITS.maxPages}）`,
  }),
  refs: z
    .union([binary("リファレンス画像"), z.array(binary("リファレンス画像"))])
    .optional()
    .openapi({
      description: `リファレンス画像（png/jpg/webp、最大${LIMITS.refCount}枚、各${LIMITS.refBytes}bytesまで）。複数枚は同じキー refs を繰り返す`,
    }),
});

export const JobCreatedSchema = z
  .object({ id: JobId, status: StatusSchema })
  .openapi("JobCreated");

export const JobDetailSchema = z
  .object({
    id: JobId,
    status: StatusSchema,
    createdAt: z.string().openapi({ example: "2026-11-24T13:17:03.916Z" }),
    finishedAt: z.string().optional(),
    error: z.string().optional().openapi({ description: "failed のときの理由" }),
    currentPage: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "いま描いているページ。未開始は null" }),
    readyPages: z
      .array(z.number().int())
      .openapi({ description: "回収済みで取得できるページ番号" }),
    logTail: z.array(z.string()).openapi({ description: "forge.log の末尾20行" }),
  })
  .openapi("JobDetail");

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

export const listStylesRoute = createRoute({
  method: "get",
  path: "/styles",
  summary: "画風の一覧",
  tags: ["styles"],
  responses: {
    200: {
      description: "利用できる画風",
      content: { "application/json": { schema: z.array(StyleSchema) } },
    },
  },
});

export const createJobRoute = createRoute({
  method: "post",
  path: "/jobs",
  summary: "漫画生成ジョブを登録",
  description:
    "ジョブは1件ずつ直列に実行されます。完了は GET /jobs/{id} をポーリングして確認してください。",
  tags: ["jobs"],
  request: {
    body: {
      required: true,
      content: { "multipart/form-data": { schema: CreateJobForm } },
    },
  },
  responses: {
    202: {
      description: "受け付けた",
      content: { "application/json": { schema: JobCreatedSchema } },
    },
    400: errorResponse("入力が不正"),
  },
});

export const getJobRoute = createRoute({
  method: "get",
  path: "/jobs/{id}",
  summary: "ジョブの状態・進捗",
  tags: ["jobs"],
  request: { params: z.object({ id: JobId }) },
  responses: {
    200: {
      description: "ジョブの状態",
      content: { "application/json": { schema: JobDetailSchema } },
    },
    400: errorResponse("不正な job id"),
    404: errorResponse("ジョブが無い"),
  },
});

export const getPageRoute = createRoute({
  method: "get",
  path: "/jobs/{id}/pages/{n}",
  summary: "完成ページ（PNG）を取得",
  tags: ["jobs"],
  request: {
    params: z.object({
      id: JobId,
      n: z.coerce.number().int().min(1).openapi({ example: 1 }),
    }),
  },
  responses: {
    200: {
      description: "pageN.png",
      content: {
        "image/png": {
          schema: z.string().openapi({ type: "string", format: "binary" }),
        },
      },
    },
    400: errorResponse("不正なパラメータ"),
    404: errorResponse("そのページはまだ無い"),
  },
});
