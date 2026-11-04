import { createDecipheriv, createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type Image = { data: string; mimeType: string; path: string; sha256: string };
export class ImageError extends Error {}
const LIMIT = 4 * 1024 * 1024;
const BUDGET = 32 * 1024 * 1024;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function mime(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (/^GIF8[79]a/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  throw new ImageError("这张图片的格式暂时读不了，请发 PNG 或 JPEG");
}
function keyFor(item: any) {
  const hex = item.aeskey;
  if (typeof hex === "string" && hex) {
    if (!/^[a-f\d]{32}$/i.test(hex)) throw new ImageError("图片密钥格式不符");
    return Buffer.from(hex, "hex");
  }
  const encoded = item.media?.aes_key;
  if (!encoded) return null;
  if (typeof encoded !== "string" || encoded.length > 64 || !/^[a-z\d+/]+={0,2}$/i.test(encoded))
    throw new ImageError("图片密钥格式不符");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 16) return bytes;
  if (bytes.length === 32 && /^[a-f\d]{32}$/i.test(bytes.toString("ascii")))
    return Buffer.from(bytes.toString("ascii"), "hex");
  throw new ImageError("图片密钥格式不符");
}

// User inputs are protected data, not a rotating cache. At the cap, ask for review
// rather than deleting images that a suspended task may still need.
export class ImageStore {
  readonly root: string;
  readonly options: { fetch?: typeof fetch; signal?: AbortSignal };
  constructor(root: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}) {
    this.root = path.resolve(root);
    this.options = options;
  }
  async load(items: any[], id: string): Promise<Image[]> {
    const selected = items.filter((item) => item?.type === 2);
    if (!selected.length || selected.length > 2) throw new ImageError("一次最多读取两张图片");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.root).isDirectory() || lstatSync(this.root).isSymbolicLink())
      throw new ImageError("图片目录不符");
    const result: Image[] = [];
    for (const [index, item] of selected.entries()) {
      const base = path.join(this.root, digest(`${id}:${index}:${JSON.stringify(item)}`));
      let file = ["png", "jpeg", "webp", "gif"]
        .map((ext) => `${base}.${ext}`)
        .find((candidate) => existsSync(candidate));
      let bytes: Buffer;
      if (file) {
        if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || statSync(file).size > LIMIT)
          throw new ImageError("已保存图片不符");
        bytes = readFileSync(file);
      } else {
        const image = item.image_item;
        const query = image?.media?.encrypt_query_param;
        if (typeof query !== "string" || !query || query.length > 16 * 1024) throw new ImageError("图片下载信息不完整");
        const key = keyFor(image);
        const url = new URL("https://novac2c.cdn.weixin.qq.com/c2c/download");
        url.searchParams.set("encrypted_query_param", query);
        const response = await (this.options.fetch ?? fetch)(url, {
          redirect: "error",
          signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(this.options.signal ? [this.options.signal] : [])]),
        });
        if (!response.ok || Number(response.headers.get("content-length")) > LIMIT + 16 || !response.body) {
          await response.body?.cancel();
          throw new ImageError("图片下载未完成或超过 4 MiB");
        }
        const reader = response.body.getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > LIMIT + 16) throw new ImageError("图片超过 4 MiB");
            parts.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        bytes = Buffer.concat(parts);
        if (key) {
          const decipher = createDecipheriv("aes-128-ecb", key, null);
          bytes = Buffer.concat([decipher.update(bytes), decipher.final()]);
        }
        if (!bytes.length || bytes.length > LIMIT) throw new ImageError("图片超过 4 MiB");
        file = `${base}.${mime(bytes).slice(6)}`;
        const files = readdirSync(this.root).filter((name) => /^[a-f\d]{64}\.(png|jpeg|webp|gif)$/.test(name));
        if (
          files.length >= 32 ||
          files.reduce((total, name) => total + lstatSync(path.join(this.root, name)).size, 0) + bytes.length > BUDGET
        )
          throw new ImageError("图片资料已达 32 张或 32 MiB，请先确认哪些旧资料可清理");
        const temporary = `${file}.tmp`;
        // Only this module's interrupted write for this exact input is replaceable.
        rmSync(temporary, { force: true });
        try {
          writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
          renameSync(temporary, file);
        } finally {
          rmSync(temporary, { force: true });
        }
      }
      result.push({ data: bytes.toString("base64"), mimeType: mime(bytes), path: file, sha256: digest(bytes) });
    }
    return result;
  }
}
