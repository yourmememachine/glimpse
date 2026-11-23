import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";

async function seededStore() {
  const store = new MemoryStore();
  await store.upsertUser(42, "Sam", 1000);
  await store.upsertSource({ chatId: -1001, userId: 42, type: "group", title: "Team", createdAt: 1000 });
  return store;
}

test("addMessage dedupes on (source, telegram message id)", async () => {
  const store = await seededStore();
  const first = await store.addMessage({ sourceId: -1001, tgMessageId: 5, fromName: "Sam", text: "hi", at: 2000 });
  const dupe = await store.addMessage({ sourceId: -1001, tgMessageId: 5, fromName: "Sam", text: "hi", at: 2000 });
  assert.equal(first.inserted, true);
  assert.equal(dupe.inserted, false);
  assert.equal(dupe.id, first.id);
  const messages = await store.messagesFor(-1001, 20);
  assert.equal(messages.length, 1);
});

test("messages are newest first, id breaks ties", async () => {
  const store = await seededStore();
  await store.addMessage({ sourceId: -1001, tgMessageId: 1, fromName: "A", text: "one", at: 2000 });
  await store.addMessage({ sourceId: -1001, tgMessageId: 2, fromName: "A", text: "two", at: 2000 });
  await store.addMessage({ sourceId: -1001, tgMessageId: 3, fromName: "A", text: "three", at: 3000 });
  const messages = await store.messagesFor(-1001, 20);
  assert.deepEqual(
    messages.map((m) => m.text),
    ["three", "two", "one"]
  );
});

test("unread counts come from read markers and never move backwards", async () => {
  const store = await seededStore();
  const a = await store.addMessage({ sourceId: -1001, tgMessageId: 1, fromName: "A", text: "one", at: 2000 });
  const b = await store.addMessage({ sourceId: -1001, tgMessageId: 2, fromName: "A", text: "two", at: 3000 });
  let [source] = await store.listSourcesWithUnread(42);
  assert.equal(source.unread, 2);
  await store.markRead(42, -1001, b.id);
  [source] = await store.listSourcesWithUnread(42);
  assert.equal(source.unread, 0);
  await store.markRead(42, -1001, a.id);
  [source] = await store.listSourcesWithUnread(42);
  assert.equal(source.unread, 0);
});

test("sources with no messages are omitted from the digest list", async () => {
  const store = await seededStore();
  assert.deepEqual(await store.listSourcesWithUnread(42), []);
});

test("pair codes replace, expire, and redeem once at store level", async () => {
  const store = new MemoryStore();
  await store.upsertUser(7, "Jo", 1000);
  await store.createPairCode({ code: "111111", userId: 7, expiresAt: 5000 });
  await store.createPairCode({ code: "222222", userId: 7, expiresAt: 5000 });
  assert.equal(await store.redeemPairCode("111111", 2000), null);
  assert.deepEqual(await store.redeemPairCode("222222", 2000), { id: 7, firstName: "Jo" });
  assert.equal(await store.redeemPairCode("222222", 2000), null);
  await store.createPairCode({ code: "333333", userId: 7, expiresAt: 5000 });
  assert.equal(await store.redeemPairCode("333333", 5000), null);
});

test("sessions resolve back to their user", async () => {
  const store = new MemoryStore();
  await store.upsertUser(7, "Jo", 1000);
  await store.createSession("deadbeef", 7, 2000);
  assert.deepEqual(await store.userForToken("deadbeef"), { id: 7, firstName: "Jo" });
  assert.equal(await store.userForToken("missing"), null);
});
