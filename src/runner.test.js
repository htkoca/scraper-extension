import test from "node:test";
import assert from "node:assert/strict";
import { fetchHistory, transcribe } from "./runner.js";
import { createSession } from "./model.js";
const make = () => createSession({ threadId: "123", start: null, end: null });
const response = (id, next) => ({
  ok: true,
  connection: {
    edges: [{ node: { id, timestamp_ms: Number(id), text_body: "hi" } }],
    page_info: { has_next_page: Boolean(next), end_cursor: next || null },
  },
});
test("transient failures back off, then complete without duplicate messages", async () => {
  const s = make(),
    sleeps = [],
    calls = [];
  const queue = [
    { ok: false, status: 429, error: "rate limit" },
    response("20", "next"),
    response("10"),
  ];
  await fetchHistory(s, {
    request: async (body) => {
      calls.push(body);
      return queue.shift();
    },
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(s.complete, true);
  assert.equal(s.messages.length, 2);
  assert.deepEqual(sleeps, [3000, 600]);
  assert.equal(calls[2].cursor, "next");
});
test("request errors preserve cursor and resume from the failed page", async () => {
  const s = make();
  let count = 0;
  await assert.rejects(
    fetchHistory(s, {
      request: async () =>
        ++count === 1
          ? response("20", "next")
          : { ok: false, status: 403, error: "Login required" },
      sleep: async () => {},
    }),
    /Login/,
  );
  assert.equal(s.complete, false);
  assert.equal(s.messages.length, 1);
  await fetchHistory(s, {
    request: async (body) => {
      assert.equal(body.cursor, "next");
      return response("10");
    },
    sleep: async () => {},
  });
  assert.equal(s.messages.length, 2);
  assert.equal(s.complete, true);
});
test("pause preserves completed pages and resume does not replay them", async () => {
  const s = make(),
    controller = new AbortController();
  await assert.rejects(
    fetchHistory(s, {
      request: async () => response("20", "next"),
      signal: controller.signal,
      sleep: async () => controller.abort(),
    }),
    /abort/i,
  );
  assert.equal(s.cursor, "next");
  assert.equal(s.messages.length, 1);
});
test("transcription is deduplicated by media id and updates matching messages", async () => {
  const s = make();
  s.messages = [1, 2].map(() => ({
    attachments: [{ type: "audio", mediaId: "99" }],
  }));
  let calls = 0;
  await transcribe(s, {
    request: async () => {
      calls++;
      return { ok: true, transcript: "Hi there" };
    },
    sleep: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(s.messages[1].transcript, "Hi there");
});
