import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const execute = promisify(execFile);
type Run = (file: string, args: string[]) => Promise<string>;
const run: Run = async (file, args) =>
  (await execute(file, args, { encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024 })).stdout;
export async function systemSnapshot(sample: Run = run): Promise<string> {
  const text = await sample("/bin/ps", ["-axo", "pid=,pcpu=,rss=,comm="]);
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error("进程采样超过上限");
  const rows = text.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    const [, pid, cpu, rss, comm] = match;
    const bundle = comm.match(/(?:^|\/)([^/]+)\.app(?:\/|$)/)?.[1];
    return [
      {
        pid: Number(pid),
        cpu: Number(cpu),
        rssMiB: Math.round(Number(rss) / 1024),
        name: (bundle ?? path.basename(comm)).slice(0, 40),
      },
    ];
  });
  if (!rows.length) throw new Error("未读到当前进程数据");
  const cpuTop = [...rows].sort((a, b) => b.cpu - a.cpu).slice(0, 5);
  const memoryTop = [...rows].sort((a, b) => b.rssMiB - a.rssMiB).slice(0, 5);
  return JSON.stringify({
    sampledAt: new Date().toISOString(),
    processCount: rows.length,
    cpuMeaning: "ps %CPU 的时点读数",
    cpuTop,
    memoryTop,
  });
}
