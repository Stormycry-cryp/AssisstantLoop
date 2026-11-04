// Failure modes: a source revokes somebody else's key; a revoked key keeps a pending poll or stream alive; CLI writes
// a different database instead of revoking through the running hub.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
setup("key-remove");
const hub = await import("../host/runtime.ts");
const { makeHandler } = await import("../host/server.ts");
const runtime = makeHandler();
after(runtime.close);
const owner = hub.addKey("owner", "me");
const worker = hub.addKey("worker", "w1");
const source = hub.addKey("source", "app");
const request = (path: string, key: string, method = "GET") =>
  runtime.handle(
    new Request("http://local" + path, {
      method,
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(2000),
    }),
  );
test("only the owner removes keys and pending work is refused immediately", async () => {
  assert.equal((await request("/v1/keys/worker/w1", source, "DELETE")).status, 401);
  const waiting = request("/v1/work?claim=pending&wait=50", worker);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await request("/v1/keys/worker/w1", owner, "DELETE")).status, 200);
  assert.equal((await waiting).status, 401);
  assert.equal((await request("/v1/work?claim=next&wait=0", worker)).status, 401);
  const response = await request(`/v1/stream?after=${hub.getView().seq}`, owner);
  const reader = response.body!.getReader();
  assert.equal((await request("/v1/keys/owner/me", owner, "DELETE")).status, 200);
  assert.equal((await reader.read()).done, true);
});
