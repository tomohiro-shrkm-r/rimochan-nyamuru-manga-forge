import { serve } from "@hono/node-server";
import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono, type z } from "@hono/zod-openapi";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HOST, LIMITS, OUT_ROOT, PORT, REF_EXTENSIONS } from "./config.js";
import {
  createJob,
  enqueue,
  failStaleJobs,
  jobDir,
  pageFile,
  readProgress,
  readRecord,
  writeRecord,
  type JobInput,
} from "./jobs.js";
import {
  createJobRoute,
  getJobRoute,
  getPageRoute,
  listStylesRoute,
  type CreateJobForm,
} from "./routes.js";
import { listStyles } from "./styles.js";

class BadRequest extends Error {}

const refExtension = (f: File): string => {
  const ext = path.extname(f.name).toLowerCase();
  if (!REF_EXTENSIONS.has(ext)) {
    throw new BadRequest(`refs は png/jpg/webp のみ: ${f.name}`);
  }
  if (f.size > LIMITS.refBytes) {
    throw new BadRequest(`refs が大きすぎる（上限 ${LIMITS.refBytes} bytes）: ${f.name}`);
  }
  return ext;
};

const toArray = <T>(v: T | readonly T[] | undefined): readonly T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v as T];

/** zod 検証済みのフォームに、サイズ・拡張子などの追加検証をして input/ に保存する */
const saveInput = async (
  form: z.infer<typeof CreateJobForm>,
  id: string,
): Promise<JobInput> => {
  const omnyText = typeof form.omny === "string" ? form.omny : await form.omny.text();
  if (!omnyText.trim()) throw new BadRequest("omny（YAML本文またはファイル）は必須");
  if (Buffer.byteLength(omnyText) > LIMITS.omnyBytes) {
    throw new BadRequest(`omny が大きすぎる（上限 ${LIMITS.omnyBytes} bytes）`);
  }

  const style = form.style || undefined;
  if (style && !(await listStyles()).some((s) => s.id === style)) {
    throw new BadRequest(`style が存在しない: ${style}（GET /styles で一覧）`);
  }

  const refs = toArray(form.refs).filter((f) => f.size > 0);
  if (refs.length > LIMITS.refCount) {
    throw new BadRequest(`refs は最大 ${LIMITS.refCount} 枚`);
  }
  const exts = refs.map(refExtension);

  const dir = path.join(jobDir(id), "input");
  const omnyPath = path.join(dir, "input.omny.yaml");
  await writeFile(omnyPath, omnyText, "utf8");
  const refPaths = await Promise.all(
    refs.map(async (f, i) => {
      const p = path.join(dir, `ref${i + 1}${exts[i]}`);
      await writeFile(p, Buffer.from(await f.arrayBuffer()));
      return p;
    }),
  );

  return {
    omnyPath,
    refPaths,
    style,
    memo: form.memo || undefined,
    pages: form.pages,
  };
};

const app = new OpenAPIHono({
  // zod の検証エラーも { error } の形に揃える
  defaultHook: (result, c) => {
    if (result.success) return;
    const msg = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return c.json({ error: msg }, 400);
  },
});

app.openapi(listStylesRoute, async (c) => c.json([...(await listStyles())], 200));

app.openapi(createJobRoute, async (c) => {
  const form = c.req.valid("form");
  const job = await createJob();
  try {
    enqueue(job.id, await saveInput(form, job.id));
  } catch (e) {
    // 検証エラーはジョブを failed にして理由を残し、400 を返す
    await writeRecord({
      ...job,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
  return c.json({ id: job.id, status: job.status }, 202);
});

app.openapi(getJobRoute, async (c) => {
  const { id } = c.req.valid("param");
  const record = await readRecord(id);
  if (!record) return c.json({ error: "ジョブが見つからない" }, 404);
  const p = await readProgress(id);
  return c.json(
    { ...record, ...p, logTail: [...p.logTail], readyPages: [...p.readyPages] },
    200,
  );
});

app.openapi(getPageRoute, async (c) => {
  const { id, n } = c.req.valid("param");
  const file = await pageFile(id, n);
  if (!file) return c.json({ error: "そのページはまだ無い" }, 404);
  return c.body(await readFile(file), 200, { "content-type": "image/png" }) as never;
});

app.doc("/openapi.json", {
  openapi: "3.0.3",
  info: {
    title: "manga-forge local API",
    version: "0.1.0",
    description:
      "OMNY（漫画ネームYAML）から完成原稿PNGを生成するローカル専用API（127.0.0.1 のみ）",
  },
});
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

app.onError((e, c) => {
  if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
  console.error(e);
  return c.json({ error: "内部エラー" }, 500);
});

await mkdir(OUT_ROOT, { recursive: true });
await failStaleJobs();
serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (i) =>
  console.log(`manga-forge-server: http://${HOST}:${i.port}  (docs: /docs)`),
);
