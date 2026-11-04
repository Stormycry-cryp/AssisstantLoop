import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
const LIMIT = 256 * 1024;
export function loadJson(file: string): any {
  if (statSync(file).size > LIMIT) throw new Error("桌面接入记录超过256KiB");
  return JSON.parse(readFileSync(file, "utf8"));
}
export function saveJson(file: string, value: unknown) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > LIMIT) throw new Error("桌面接入记录超过256KiB");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file + ".tmp", text, { mode: 0o600 });
  renameSync(file + ".tmp", file);
}
