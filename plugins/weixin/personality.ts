import { readFileSync } from "node:fs";

export const PERSONA = readFileSync(new URL("./persona.md", import.meta.url), "utf8");

export function formatReply(value: string) {
  let emojiSeen = false;
  const plain = value
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s*(?:#{1,6}\s+|[-*•]\s+)/gm, "")
    .replace(/。/g, "\n");
  const lines: string[] = [];
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
  for (const raw of plain.split(/\r?\n/)) {
    let line = "";
    for (const { segment } of segmenter.segment(raw.trim().replace(/\.$/, ""))) {
      if (/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(segment)) {
        if (emojiSeen) continue;
        emojiSeen = true;
      }
      if (Array.from(line + segment).length > 30) {
        if (line.trim()) lines.push(line.trim());
        line = "";
      }
      line += segment;
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines.join("\n");
}
