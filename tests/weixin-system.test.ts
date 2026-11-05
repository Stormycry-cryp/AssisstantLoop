// A process check must use a fixed read-only host command, never user-supplied
// shell text or full command lines, and its output must remain bounded data.
import assert from "node:assert/strict";
import { test } from "node:test";
import { systemSnapshot } from "../plugins/weixin/system.ts";
test("Wechat system sampling: fixed arguments, bounded process data and no command lines", async () => {
  const calls: any[] = [];
  const snapshot = await systemSnapshot(async (file, args) => {
    calls.push({ file, args });
    return Array.from(
      { length: 100 },
      (_, i) => `${100 + i} ${i} ${1000 * i} /Applications/Test App.app/Contents/MacOS/test-${i}`,
    ).join("\n");
  });
  assert.deepEqual(calls, [{ file: "/bin/ps", args: ["-axo", "pid=,pcpu=,rss=,comm="] }]);
  assert.ok(snapshot.length < 2000);
  assert.doesNotMatch(snapshot, /\/Applications|Contents|MacOS/);
  assert.match(snapshot, /Test App/);
  assert.match(snapshot, /199/);
});
