import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const OUT_ROOT = path.join(REPO_ROOT, "out");
export const STYLES_DIR = path.join(REPO_ROOT, "styles");

// Windows では System32 の bash.exe が WSL なので使わない。Git Bash を明示する
export const BASH_PATH =
  process.env.BASH_PATH ?? "C:\\Program Files\\Git\\bin\\bash.exe";

export const HOST = "127.0.0.1";
export const PORT = Number(process.env.PORT ?? 8787);

export const LIMITS = {
  omnyBytes: 1_000_000,
  memoChars: 2_000,
  refCount: 3,
  refBytes: 10_000_000,
  maxPages: 50,
} as const;

export const REF_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
]);
