import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelegram } from "../src/telegram.js";
import { createAi } from "../src/ai.js";

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

test("telegram sendMessage posts to the bot endpoint", async () => {
  const calls = [];
  const tg = createTelegram({
    token: "TOK",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true, result: { message_id: 9 } });
    },
  });
  const result = await tg.sendMessage(-1001, "hello", { replyToMessageId: 5 });
  assert.equal(result.message_id, 9);
  assert.equal(calls[0].url, "https://api.telegram.org/botTOK/sendMessage");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { chat_id: -1001, text: "hello", reply_to_message_id: 5 });
});

test("telegram sendMessage throws on a failed response", async () => {
  const tg = createTelegram({
    token: "TOK",
    fetchImpl: async () => jsonResponse({}, { ok: false, status: 500 }),
  });
  await assert.rejects(() => tg.sendMessage(1, "hi"));
});

test("draft returns null without a key and never calls out", async () => {
  let called = false;
  const ai = createAi({
    groqKey: "",
    fetchImpl: async () => {
      called = true;
      return jsonResponse({});
    },
  });
  assert.equal(await ai.draftReply({ message: { text: "hi" } }), null);
  assert.equal(await ai.transcribe(new Uint8Array([1])), null);
  assert.equal(called, false);
});

test("draft returns the model text on success", async () => {
  const calls = [];
  const ai = createAi({
    groqKey: "KEY",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ choices: [{ message: { content: "On my way!" } }] });
    },
  });
  const draft = await ai.draftReply({ source: { title: "Team" }, message: { from: "Sam", text: "eta?" } });
  assert.equal(draft, "On my way!");
  assert.equal(calls[0].url, "https://api.groq.com/openai/v1/chat/completions");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "llama-3.3-70b-versatile");
  assert.equal(calls[0].init.headers.authorization, "Bearer KEY");
});

test("draft returns null when the request fails", async () => {
  const ai = createAi({
    groqKey: "KEY",
    fetchImpl: async () => jsonResponse({}, { ok: false, status: 429 }),
  });
  assert.equal(await ai.draftReply({ message: { text: "hi" } }), null);
});

test("transcribe returns text on success and null on failure", async () => {
  const okAi = createAi({
    groqKey: "KEY",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.groq.com/openai/v1/audio/transcriptions");
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.get("model"), "whisper-large-v3-turbo");
      return jsonResponse({ text: "  spoken words  " });
    },
  });
  assert.equal(await okAi.transcribe(new Uint8Array([1, 2])), "spoken words");

  const badAi = createAi({
    groqKey: "KEY",
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(await badAi.transcribe(new Uint8Array([1, 2])), null);
});
