import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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

export const writeRecord = (r: JobRecord): Promise<void> =>
  writeFile(recordPath(r.id), JSON.stringify(r, null, 2), "utf8");

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

// codex のレート制限対策で1件ずつ直列に実行する
let queue: Promise<void> = Promise.resolve();
export const enqueue = (id: string, input: JobInput): void => {
  queue = queue.then(() => execute(id, input));
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
