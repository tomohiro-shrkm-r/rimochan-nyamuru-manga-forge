import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { STYLES_DIR } from "./config.js";

export type StyleInfo = { readonly id: string; readonly name: string };

const nameOf = (body: string): string =>
  /^name:\s*"(.*)"\s*$/m.exec(body)?.[1] ?? "";

/** styles/*.yaml（_ 始まりを除く）の一覧。id は forge.sh -s に渡す名前 */
export const listStyles = async (): Promise<readonly StyleInfo[]> => {
  const files = (await readdir(STYLES_DIR))
    .filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
    .sort();
  return Promise.all(
    files.map(async (f) => ({
      id: path.basename(f, ".yaml"),
      name: nameOf(await readFile(path.join(STYLES_DIR, f), "utf8")),
    })),
  );
};
