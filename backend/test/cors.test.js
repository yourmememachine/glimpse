import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.js";
import { MemoryStore } from "../src/store.js";

function makeApp() {
  return createApp({
    store: new MemoryStore(),
    tg: { async sendMessage() { return { message_id: 1 }; } },
    ai: { async draftReply() { return null; }, async transcribe() { return null; } },
    webhookSecret: "s3cret",
  });
}

test("OPTIONS preflight is answered with CORS headers, no auth needed", async () => {
  const app = makeApp();
  const res = await app.fetch(new Request("http://x/v1/digest", {
    method: "OPTIONS",
    headers: { origin: "http://localhost:5173", "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
  }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /authorization/);
});

test("API responses carry CORS headers so the WebView can read them", async () => {
  const app = makeApp();
  const res = await app.fetch(new Request("http://x/health", { headers: { origin: "http://localhost:5173" } }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const err = await app.fetch(new Request("http://x/v1/digest", { headers: { origin: "http://localhost:5173" } }));
  assert.equal(err.status, 401);
  assert.equal(err.headers.get("access-control-allow-origin"), "*");
});
