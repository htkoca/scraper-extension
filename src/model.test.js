import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptPage as acceptNormalizedPage,
  createSession,
  isMediaUrl,
  parseDateRange,
} from "./model.js";
import { attachmentsFrom, normalizeMessage } from "./instagram-model.js";
import { htmlReport, jsonReport, textReport } from "./export.js";
const acceptPage = (session, connection, viewerId) =>
  acceptNormalizedPage(session, {
    messages: connection.edges?.map((e) => normalizeMessage(e.node, viewerId)),
    hasMore: connection.page_info?.has_next_page,
    nextCursor: connection.page_info?.end_cursor,
  });
const node = (id, time, text = "hello") => ({
  id,
  timestamp_ms: time,
  text_body: text,
  sender_fbid: "1",
  sender: { name: "Alice", user_dict: { id: "1" } },
});
const page = (nodes, next = null) => ({
  edges: nodes.map((node) => ({ node })),
  page_info: { has_next_page: Boolean(next), end_cursor: next },
});
const session = (extra) =>
  createSession({ threadId: "123", start: null, end: null, ...extra });
test("pagination deduplicates boundary messages and honours date range", () => {
  const s = session({ start: 150, end: 350 });
  acceptPage(
    s,
    page([node("4", 400), node("3", 300), node("2", 200)], "next"),
    "1",
  );
  acceptPage(s, page([node("2", 200), node("1", 100)]), "1");
  assert.deepEqual(
    s.messages.map((m) => m.id),
    ["3", "2"],
  );
  assert.equal(s.complete, true);
  assert.equal(s.messages[0].isMe, true);
});
test("cursor loops and invalid timestamps cannot corrupt the checkpoint", () => {
  const s = session();
  acceptPage(s, page([node("1", 100)], "next"));
  assert.throws(() => acceptPage(s, page([node("2", 90)], "next")), /cursor/);
  assert.throws(
    () => acceptPage(s, page([node("3", 80), node("bad", "oops")], "last")),
    /timestamp/,
  );
  assert.equal(s.messages.length, 1);
  assert.equal(s.cursor, "next");
});
test("empty history is valid but malformed responses are not", () => {
  const s = session();
  acceptPage(s, page([]));
  assert.equal(s.complete, true);
  assert.throws(() => acceptPage(session(), {}), /Unsupported/);
  assert.throws(() => acceptPage(session(), page([], "next")), /empty page/);
});
test("latest-message limit has no product-imposed maximum", () => {
  const s = session({ limit: 2 });
  acceptPage(s, page([node("3", 300), node("2", 200), node("1", 100)], "next"));
  assert.equal(s.messages.length, 2);
  assert.equal(s.complete, true);
});
test("media parsing selects largest candidate and excludes avatars", () => {
  const out = attachmentsFrom({
    content: {
      image_versions2: {
        candidates: [
          { width: 10, url: "https://a.cdninstagram.com/small.jpg" },
          { width: 100, url: "https://a.cdninstagram.com/large.jpg" },
        ],
      },
      audio_attachments: [
        {
          attachment_fbid: "99",
          playable_url: "https://cdn.fbsbx.com/voice.mp4",
        },
      ],
      sender: { profile_pic_url: "https://a.fbcdn.net/avatar.jpg" },
    },
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].url, "https://a.cdninstagram.com/large.jpg");
  assert.equal(out[1].type, "audio");
  assert.equal(out[1].mediaId, "99");
});
test("CDN allowlist rejects lookalikes and non-HTTPS", () => {
  for (const url of [
    "http://a.fbcdn.net/x",
    "https://fbcdn.net.evil.com/x",
    "https://evilfbcdn.net/x",
    "https://user:pass@a.fbcdn.net/x",
    "javascript:alert(1)",
  ])
    assert.equal(isMediaUrl(url), false);
  assert.equal(isMediaUrl("https://a.fbcdn.net/x"), true);
});
test("exports escape HTML, preserve raw JSON optionally and label partial history", () => {
  const s = session({ raw: true });
  acceptPage(s, page([node("1", 100, '<script>alert("x")</script>')], "next"));
  const html = htmlReport(s);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("PARTIAL EXPORT"));
  assert.ok(JSON.parse(jsonReport(s)).messages[0].raw);
  s.options.raw = false;
  assert.equal(JSON.parse(jsonReport(s)).messages[0].raw, undefined);
  assert.match(textReport(s), /PARTIAL EXPORT/);
});
test("date range rejects inversion and preserves optional endpoints", () => {
  assert.deepEqual(parseDateRange("", ""), { start: null, end: null });
  assert.throws(() => parseDateRange("2026-10-31", "2026-01-01"), /start date/);
});

test("saved posts preserve feed order and export explicitly unknown publication dates", () => {
  const s = session({ platform: "instagram-saved" });
  const post = (id, timestamp) => ({
    id,
    timestamp,
    sender: "artist",
    caption: "Exact caption",
    text: "Exact caption",
    url: `https://www.instagram.com/p/${id}/`,
    attachments: [],
    reactions: [],
  });
  acceptNormalizedPage(s, {
    messages: [post("z", null), post("a", 1000)],
    hasMore: true,
    nextCursor: "next",
  });
  acceptNormalizedPage(s, {
    messages: [post("a", 1000), post("b", null)],
    hasMore: false,
  });
  assert.deepEqual(
    s.messages.map((p) => p.id),
    ["z", "a", "b"],
  );
  const json = JSON.parse(jsonReport(s));
  assert.deepEqual(
    json.posts.map((p) => p.publishedAt),
    [null, "1970-01-01T00:00:01.000Z", null],
  );
  assert.match(textReport(s), /Publication date unavailable/);
  assert.match(htmlReport(s), /Publication date unavailable/);
  assert.ok(textReport(s).indexOf("/p/z/") < textReport(s).indexOf("/p/a/"));
  assert.ok(htmlReport(s).indexOf("/p/z/") < htmlReport(s).indexOf("/p/a/"));
});

test("unknown dates remain invalid for conversations and saved posts reject date filters", () => {
  const page = { messages: [{ id: "one", timestamp: null }], hasMore: false };
  assert.throws(() => acceptNormalizedPage(session(), page), /timestamp/);
  assert.throws(
    () =>
      acceptNormalizedPage(
        session({ platform: "instagram-saved", start: 100 }),
        page,
      ),
    /Date filters/,
  );
  assert.throws(
    () =>
      acceptNormalizedPage(session({ platform: "instagram-saved" }), {
        ...page,
        messages: [{ id: "one", timestamp: undefined }],
      }),
    /timestamp/,
  );
});
