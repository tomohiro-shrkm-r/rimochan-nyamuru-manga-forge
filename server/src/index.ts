import { serve } from "@hono/node-server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { HOST, LIMITS, OUT_ROOT, PORT, REF_EXTENSIONS } from "./config.js";
import {
  createJob,
  enqueue,
  failStaleJobs,
  isJobId,
  jobDir,
  pageFile,
  readProgress,
  readRecord,
  writeRecord,
  type JobInput,
} from "./jobs.js";
import { listStyles } from "./styles.js";

class BadRequest extends Error {}

const asFile = (v: FormDataEntryValue | null): File | undefined =>
  v instanceof File && v.size > 0 ? v : undefined;

const asText = (v: FormDataEntryValue | null): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

const parsePages = (v: FormDataEntryValue | null): number | undefined => {
  const s = asText(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxPages) {
    throw new BadRequest(`pages は 1〜${LIMITS.maxPages} の整数`);
  }
  return n;
};

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

/** multipart を検証し、input/ にファイルを保存して JobInput を返す */
const parseInput = async (form: FormData, id: string): Promise<JobInput> => {
  const omnyField = form.get("omny");
  const omnyText =
    typeof omnyField === "string" ? omnyField : await asFile(omnyField)?.text();
  if (!omnyText?.trim()) throw new BadRequest("omny（YAML本文またはファイル）は必須");
  if (Buffer.byteLength(omnyText) > LIMITS.omnyBytes) {
    throw new BadRequest(`omny が大きすぎる（上限 ${LIMITS.omnyBytes} bytes）`);
  }

  const memo = asText(form.get("memo"));
  if (memo && memo.length > LIMITS.memoChars) {
    throw new BadRequest(`memo は ${LIMITS.memoChars} 文字まで`);
  }

  const style = asText(form.get("style"));
  if (style && !(await listStyles()).some((s) => s.id === style)) {
    throw new BadRequest(`style が存在しない: ${style}（GET /styles で一覧）`);
  }

  const refs = form.getAll("refs").flatMap((v) => asFile(v) ?? []);
  if (refs.length > LIMITS.refCount) {
    throw new BadRequest(`refs は最大 ${LIMITS.refCount} 枚`);
  }
  const exts = refs.map(refExtension);
  const pages = parsePages(form.get("pages"));

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

  return { omnyPath, refPaths, style, memo, pages };
};

const app = new Hono();

app.get("/styles", async (c) => c.json(await listStyles()));

app.post("/jobs", async (c) => {
  const form = await c.req.formData().catch(() => {
    throw new BadRequest("multipart/form-data で送ってほしい");
  });
  const job = await createJob();
  try {
    enqueue(job.id, await parseInput(form, job.id));
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

app.get("/jobs/:id", async (c) => {
  const id = c.req.param("id");
  if (!isJobId(id)) return c.json({ error: "不正な job id" }, 400);
  const record = await readRecord(id);
  if (!record) return c.json({ error: "ジョブが見つからない" }, 404);
  return c.json({ ...record, ...(await readProgress(id)) });
});

app.get("/jobs/:id/pages/:n", async (c) => {
  const id = c.req.param("id");
  const n = Number(c.req.param("n"));
  if (!isJobId(id) || !Number.isInteger(n) || n < 1) {
    return c.json({ error: "不正なパラメータ" }, 400);
  }
  const file = await pageFile(id, n);
  if (!file) return c.json({ error: "そのページはまだ無い" }, 404);
  return new Response(await readFile(file), {
    headers: { "content-type": "image/png" },
  });
});

app.onError((e, c) => {
  if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
  console.error(e);
  return c.json({ error: "内部エラー" }, 500);
});

await mkdir(OUT_ROOT, { recursive: true });
await failStaleJobs();
serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (i) =>
  console.log(`manga-forge-server: http://${HOST}:${i.port}`),
);
