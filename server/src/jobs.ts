import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { BASH_PATH, OUT_ROOT, REPO_ROOT } from "./config.js";

export type JobStatus = "queued" | "running" | "done" | "failed";

export type JobRecord = {
  readonly id: string;
  readonly status: JobStatus;
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
};

export type JobInput = {
  readonly omnyPath: string;
  readonly refPaths: readonly string[];
  readonly style?: string;
  readonly memo?: string;
  readonly pages?: number;
};

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isJobId = (s: string): boolean => JOB_ID.test(s);

export const jobDir = (id: string): string => path.join(OUT_ROOT, id);
const recordPath = (id: string): string => path.join(jobDir(id), "job.json");

const RENAME_RETRYABLE: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Windows では、相手が読んでいる最中のファイルへの rename が EPERM 等で失敗するので少し待って再試行する */
const renameWithRetry = async (from: string, to: string): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 20 || !RENAME_RETRYABLE.has(code)) throw e;
      await sleep(10 * (attempt + 1));
    }
  }
};

/** 一時ファイルに書いてから rename する。読み手が書きかけの JSON を見ないようにするため */
export const writeRecord = async (r: JobRecord): Promise<void> => {
  const tmp = `${recordPath(r.id)}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(r, null, 2), "utf8");
  await renameWithRetry(tmp, recordPath(r.id));
};

export const readRecord = async (id: string): Promise<JobRecord | undefined> => {
  try {
    return JSON.parse(await readFile(recordPath(id), "utf8")) as JobRecord;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`job.json を読めない: ${id}`, { cause: e });
  }
};

/** 入力ファイルを置く input/ を作り、queued のジョブを登録する */
export const createJob = async (): Promise<JobRecord> => {
  const id = randomUUID();
  await mkdir(path.join(jobDir(id), "input"), { recursive: true });
  const record: JobRecord = {
    id,
    status: "queued",
    createdAt: new Date().toISOString(),
  };
  await writeRecord(record);
  return record;
};

const buildArgs = (id: string, input: JobInput): readonly string[] => [
  "scripts/forge.sh",
  "-n", input.omnyPath,
  "-o", jobDir(id),
  ...(input.pages !== undefined ? ["-p", String(input.pages)] : []),
  ...(input.style ? ["-s", input.style] : []),
  ...(input.memo ? ["-m", input.memo] : []),
  ...input.refPaths.flatMap((r) => ["-r", r]),
];

/** forge.sh を実行して終了コードと stderr 末尾を返す */
const runForge = (
  id: string,
  input: JobInput,
): Promise<{ code: number | null; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(BASH_PATH, [...buildArgs(id, input)], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-2_000);
    });
    child.on("error", (e) =>
      reject(new Error(`bash を起動できない（BASH_PATH=${BASH_PATH}）`, { cause: e })),
    );
    child.on("close", (code) => resolve({ code, stderr }));
  });

const execute = async (id: string, input: JobInput): Promise<void> => {
  const base = await readRecord(id);
  if (!base) return;
  await writeRecord({ ...base, status: "running" });
  try {
    const { code, stderr } = await runForge(id, input);
    const finishedAt = new Date().toISOString();
    await writeRecord(
      code === 0
        ? { ...base, status: "done", finishedAt }
        : {
            ...base,
            status: "failed",
            finishedAt,
            error: `forge.sh が終了コード ${code} で終了。${stderr.trim()}`,
          },
    );
  } catch (e) {
    await writeRecord({
      ...base,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: e instanceof Error ? e.message : String(e),
    });
  }
};

/** execute が想定外に失敗したとき、ジョブを failed にする（これ自体は例外を投げない） */
const markFailed = async (id: string, e: unknown): Promise<void> => {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`ジョブ ${id} の実行で想定外のエラー:`, e);
  try {
    const base = await readRecord(id);
    if (base) {
      await writeRecord({
        ...base,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: `内部エラー: ${message}`,
      });
    }
  } catch (inner) {
    console.error(`ジョブ ${id} を failed に更新できない:`, inner);
  }
};

// codex のレート制限対策で1件ずつ直列に実行する。
// 1件が例外を投げてもキューが rejected のまま固まらないよう、必ず catch で受ける
let queue: Promise<void> = Promise.resolve();
export const enqueue = (id: string, input: JobInput): void => {
  queue = queue
    .then(() => execute(id, input))
    .catch((e: unknown) => markFailed(id, e));
};

/** 再起動で途中になったジョブを failed にする */
export const failStaleJobs = async (): Promise<void> => {
  const ids = await readdir(OUT_ROOT).catch(() => [] as string[]);
  await Promise.all(
    ids.filter(isJobId).map(async (id) => {
      const r = await readRecord(id);
      if (r && (r.status === "queued" || r.status === "running")) {
        await writeRecord({
          ...r,
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: "サーバー再起動により中断",
        });
      }
    }),
  );
};

export type JobProgress = {
  readonly currentPage: number | null;
  readonly logTail: readonly string[];
  readonly readyPages: readonly number[];
};

export const readProgress = async (id: string): Promise<JobProgress> => {
  const dir = jobDir(id);
  const log = await readFile(path.join(dir, "forge.log"), "utf8").catch(() => "");
  const last = [...log.matchAll(/===== page(\d+) =====/g)].at(-1)?.[1];
  const files = await readdir(dir).catch(() => [] as string[]);
  const readyPages = files
    .map((f) => /^page(\d+)\.png$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  return {
    currentPage: last === undefined ? null : Number(last),
    logTail: log.split(/\r?\n/).filter(Boolean).slice(-20),
    readyPages,
  };
};

export const pageFile = async (
  id: string,
  n: number,
): Promise<string | undefined> => {
  const p = path.join(jobDir(id), `page${n}.png`);
  return (await stat(p).catch(() => undefined))?.isFile() ? p : undefined;
};
