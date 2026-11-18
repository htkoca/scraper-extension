import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { whatsappRequest } from "./whatsapp.js";
import { fetchHistory } from "./runner.js";
import { createSession } from "./model.js";
import { htmlReport, jsonReport, textReport } from "./export.js";
import { platformForUrl, getPlatform } from "./platforms.js";
import { downloadWhatsAppAudio } from "./whatsapp-media.js";
import { downloadMedia } from "./media.js";
import { zipSync, unzipSync } from "fflate";

function environment({ empty = false, exhausted = false } = {}) {
  const message = (n) => ({
    id: { fromMe: n % 2 === 0, toString: () => `false_chat@g.us_${n}` },
    t: n,
    type: "chat",
    body: `<message ${n}>`,
    from: { _serialized: "friend@lid" },
  });
  let messages = empty
    ? []
    : Array.from({ length: 55 }, (_, i) => message(i + 10));
  const chat = {
    id: { _serialized: "chat@g.us" },
    formattedTitle: "Test chat",
    msgs: {
      getModelsArray: () => messages,
      msgLoadState: { noEarlierMsgs: exhausted },
    },
  };
  let active = chat,
    loads = 0;
  const loader = {
    loadEarlierMsgs: async () => {
      loads++;
      if (loads > 1 || empty) return [];
      const older = [message(8), message(9)];
      messages = [...older, ...messages];
      return older;
    },
  };
  const env = vm.createContext({
    Blob,
    Uint8Array,
    btoa,
    setTimeout,
    clearTimeout,
    location: { origin: "https://web.whatsapp.com" },
    window: {
      require: (name) => {
        if (name === "WAWebCollections")
          return {
            Chat: {
              getActive: () => active,
              get: (key) => (key === "chat@g.us" ? chat : undefined),
            },
            Contact: { get: () => ({ name: "Friend" }) },
          };
        if (name === "WAWebChatLoadMessages") return loader;
        throw new Error("Unknown module");
      },
    },
  });
  const request = (body) =>
    vm.runInContext(
      `(${whatsappRequest.toString()})(${JSON.stringify(body)})`,
      env,
    );
  return {
    request,
    env,
    chat,
    loader,
    loads: () => loads,
    switchChat: () => {
      active = { id: { _serialized: "other@lid" } };
    },
  };
}

test("WhatsApp serialized adapter collects loaded and earlier pages through the shared runner", async () => {
  const e = environment();
  const context = await e.request({ kind: "context" });
  assert.equal(context.threadId, "chat@g.us");
  const s = createSession({
    platform: "whatsapp",
    threadId: context.threadId,
    start: null,
    end: null,
    raw: true,
  });
  await fetchHistory(s, { request: e.request, sleep: async () => {} });
  assert.equal(s.complete, true);
  assert.equal(s.messages.length, 57);
  assert.equal(new Set(s.messages.map((m) => m.id)).size, 57);
  assert.equal(s.messages[0].timestamp, 64000);
  assert.equal(s.messages[0].isMe, true);
  assert.equal(e.loads(), 2);
  assert.equal(JSON.parse(jsonReport(s)).platform, "whatsapp");
  assert.match(textReport(s), /^WhatsApp conversation/);
  assert.match(htmlReport(s), /WhatsApp conversation/);
  assert.ok(!htmlReport(s).includes("<message"));
});

function audioEnvironment() {
  const e = environment({ exhausted: true });
  const message = e.chat.msgs.getModelsArray().at(-1);
  const bytes = Uint8Array.from({ length: 410000 }, (_, i) => i % 251);
  let downloads = 0;
  Object.assign(message, {
    type: "ptt",
    body: "",
    mimetype: "audio/ogg; codecs=opus",
    mediaData: {},
    downloadMedia: async () => {
      downloads++;
      message.mediaObject = {
        mediaBlob: {
          forceToBlob: () => new Blob([bytes], { type: message.mimetype }),
        },
      };
    },
  });
  return { ...e, message, bytes, downloads: () => downloads };
}

test("WhatsApp audio survives chunk transport and ZIP export without exposing internal media keys", async () => {
  const e = audioEnvironment();
  e.message.mediaKey = "private-key";
  const page = await e.request({ kind: "messages", threadId: "chat@g.us" });
  const message = page.page.messages[0];
  assert.equal(message.attachments[0].provider, "whatsapp");
  assert.ok(!JSON.stringify(page).includes("private-key"));
  const offsets = [];
  const result = await downloadMedia([message], {
    fetcher: () => {
      throw new Error("Audio must stay inside WhatsApp");
    },
    loadWhatsAppAudio: (attachment) =>
      downloadWhatsAppAudio(attachment, {
        threadId: "chat@g.us",
        request: async (request) => {
          offsets.push(request.offset);
          const chunk = await e.request(request);
          assert.ok(JSON.stringify(chunk).length < 300000);
          return chunk;
        },
      }),
  });
  assert.equal(result.failures.length, 0);
  assert.deepEqual(offsets, [0, 196608, 393216]);
  assert.equal(e.downloads(), 1);
  const path = message.attachments[0].path;
  assert.match(path, /\.ogg$/);
  assert.deepEqual(
    unzipSync(zipSync(Object.fromEntries(result.files)))[path],
    e.bytes,
  );
  const session = createSession({
    platform: "whatsapp",
    threadId: "chat@g.us",
  });
  session.messages = [message];
  assert.ok(
    htmlReport(session, new Map(), result.paths).includes(`href="${path}"`),
  );
  assert.match(htmlReport(session), /available in the ZIP/);
  assert.ok(!htmlReport(session).includes('href="whatsapp:'));
  assert.ok(
    !htmlReport(
      session,
      new Map(),
      new Map([[message.attachments[0].url, "javascript:alert(1)"]]),
    ).includes("javascript:"),
  );
});

test("WhatsApp refuses missing, view-once, nonaudio, changed-chat and unavailable audio", async () => {
  const e = audioEnvironment();
  const request = {
    kind: "media",
    threadId: "chat@g.us",
    messageId: e.message.id.toString(),
  };
  assert.match(
    (await e.request({ ...request, messageId: "other-chat-message" })).error,
    /unloaded/,
  );
  assert.match((await e.request({ ...request, offset: -1 })).error, /offset/);
  assert.match(
    (await e.request({ ...request, threadId: undefined })).error,
    /conversation/,
  );
  e.message.isViewOnce = true;
  assert.equal((await e.request(request)).ok, false);
  assert.equal(e.downloads(), 0);
  e.message.isViewOnce = false;
  e.message.type = "image";
  assert.equal((await e.request(request)).ok, false);
  e.message.type = "ptt";
  const download = e.message.downloadMedia;
  e.message.downloadMedia = async () => {};
  assert.match((await e.request(request)).error, /unavailable/);
  e.message.downloadMedia = async () => {
    await download();
    e.switchChat();
  };
  assert.match((await e.request(request)).error, /conversation changed/);
  // A named source remains usable without switching the user's active chat.
  assert.equal(
    (await e.request({ ...request, targetId: "chat@g.us" })).ok,
    true,
  );
  assert.match(
    (
      await e.request({
        ...request,
        targetId: "chat@g.us",
        offset: e.bytes.length,
      })
    ).error,
    /past the end/,
  );
});

test("WhatsApp chunk failures retain message history and cancellation stops the next chunk", async () => {
  const e = audioEnvironment();
  const page = await e.request({ kind: "messages" });
  const message = page.page.messages[0];
  const attachment = message.attachments[0];
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    downloadWhatsAppAudio(attachment, {
      threadId: "chat@g.us",
      signal: controller.signal,
      request: async (request) => {
        calls++;
        const result = await e.request(request);
        controller.abort();
        return result;
      },
    }),
    /abort/i,
  );
  assert.equal(calls, 1);
  const result = await downloadMedia([message], {
    loadWhatsAppAudio: (audio) =>
      downloadWhatsAppAudio(audio, {
        threadId: "chat@g.us",
        request: async (request) => {
          const chunk = await e.request(request);
          return { ...chunk, nextOffset: 0 };
        },
      }),
  });
  assert.equal(result.files.size, 0);
  assert.match(result.failures[0].error, /checkpoint/);
  assert.equal(message.attachments[0].status, "failed");
  assert.equal(message.type, "ptt");
});

test("WhatsApp limits and known history boundaries avoid extra loads", async () => {
  const e = environment({ exhausted: true });
  const s = createSession({
    platform: "whatsapp",
    threadId: "chat@g.us",
    start: null,
    end: null,
    limit: 2,
  });
  await fetchHistory(s, { request: e.request, sleep: async () => {} });
  assert.equal(s.messages.length, 2);
  assert.equal(s.complete, true);
  assert.equal(e.loads(), 0);
  const blank = environment({ empty: true, exhausted: true });
  assert.equal((await blank.request({ kind: "messages" })).page.hasMore, false);
});

test("WhatsApp errors preserve the checkpoint and allow retry", async () => {
  const e = environment();
  e.loader.loadEarlierMsgs = async () => {
    throw new Error("Temporarily unavailable");
  };
  const s = createSession({
    platform: "whatsapp",
    threadId: "chat@g.us",
    start: null,
    end: null,
  });
  await assert.rejects(
    fetchHistory(s, { request: e.request, sleep: async () => {} }),
    /Temporarily unavailable/,
  );
  assert.equal(s.messages.length, 55);
  assert.equal(s.complete, false);
  e.loader.loadEarlierMsgs = async () => [];
  await fetchHistory(s, { request: e.request, sleep: async () => {} });
  assert.equal(s.messages.length, 55);
  assert.equal(s.complete, true);
});

test("WhatsApp rejects chat switches, missing checkpoints, unsupported loaders and origins", async () => {
  const e = environment();
  assert.match(
    (await e.request({ kind: "messages", cursor: "missing" })).error,
    /checkpoint/,
  );
  const page = await e.request({ kind: "messages" });
  const second = await e.request({
    kind: "messages",
    cursor: page.page.nextCursor,
  });
  e.loader.loadEarlierMsgs = async () => ({ unexpected: true });
  assert.match(
    (await e.request({ kind: "messages", cursor: second.page.nextCursor }))
      .error,
    /unsupported/,
  );
  e.switchChat();
  assert.match(
    (await e.request({ kind: "messages", threadId: "chat@g.us" })).error,
    /changed conversations/,
  );
  e.env.location.origin = "https://evil.example";
  assert.match(
    (await e.request({ kind: "context" })).error,
    /web.whatsapp.com/,
  );
});

test("platform routing rejects lookalike hosts and unknown platforms", () => {
  assert.equal(platformForUrl("https://web.whatsapp.com/").id, "whatsapp");
  assert.equal(
    platformForUrl("https://www.instagram.com/direct/t/123/").id,
    "instagram",
  );
  for (const url of [
    "https://web.whatsapp.com.evil.com/",
    "http://web.whatsapp.com/",
    "https://www.instagram.com/direct/inbox/",
    "invalid",
  ])
    assert.equal(platformForUrl(url), null);
  assert.throws(() => getPlatform("toString"), /Unsupported/);
});

test("shared validation rejects an invalid page without advancing the checkpoint", async () => {
  const { acceptPage } = await import("./model.js");
  const s = createSession({ platform: "whatsapp", start: null, end: null });
  assert.throws(
    () =>
      acceptPage(s, {
        messages: [
          { id: "valid", timestamp: 100 },
          { id: "bad", timestamp: NaN },
        ],
        hasMore: true,
        nextCursor: "next",
      }),
    /timestamp/,
  );
  assert.equal(s.messages.length, 0);
  assert.equal(s.cursor, null);
});

test("WhatsApp named target collects without changing the active conversation", async () => {
  const e = environment({ exhausted: true });
  e.switchChat();
  const context = await e.request({ kind: "context", targetId: "chat@g.us" });
  assert.equal(context.threadId, "chat@g.us");
  const result = await e.request({
    kind: "messages",
    targetId: "chat@g.us",
    threadId: context.threadId,
  });
  assert.equal(result.ok, true);
  assert.equal(result.page.messages.length, 50);
  assert.equal(
    (await e.request({ kind: "context", targetId: "missing" })).ok,
    false,
  );
});
