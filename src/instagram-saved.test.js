import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { instagramSavedRequest } from "./instagram-saved.js";
import { platformForUrl } from "./platforms.js";
import { createSession } from "./model.js";
import { fetchHistory } from "./runner.js";
import { jsonReport, textReport, htmlReport } from "./export.js";

const post = (
  id,
  timestamp = 100,
  caption = { text: "Caption\nwith Unicode 🍵 and <script>markup</script>" },
) => ({
  pk: id,
  code: `code_${id}`,
  taken_at: timestamp,
  caption,
  user: { pk: "7", username: "author" },
  media_type: 1,
});
function fixture(pages) {
  const calls = [];
  const env = vm.createContext({
    location: {
      origin: "https://www.instagram.com",
      pathname: "/me/saved/all-posts/",
    },
    document: { cookie: "ds_user_id=42; csrftoken=fixture-secret" },
    URLSearchParams,
    AbortSignal,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const cursor =
        new URL(url, "https://www.instagram.com").searchParams.get("max_id") ||
        "first";
      const page = pages[cursor];
      if (page instanceof Error) throw page;
      return page?.http || { ok: true, json: async () => page };
    },
  });
  return {
    calls,
    env,
    request: (body) =>
      vm.runInContext(
        `(${instagramSavedRequest.toString()})(${JSON.stringify(body)})`,
        env,
      ),
  };
}
const session = (extra = {}) =>
  createSession({
    platform: "instagram-saved",
    threadId: "saved-42",
    start: null,
    end: null,
    ...extra,
  });
const run = (s, f) =>
  fetchHistory(s, { request: f.request, sleep: async () => {} });

test("saved posts collect full captions across pages, deduplicate and preserve saved-feed order", async () => {
  const f = fixture({
    first: {
      status: "ok",
      items: [{ media: post("1", 50) }, { media: post("2", 200, null) }],
      more_available: true,
      next_max_id: "next&cursor",
    },
    "next&cursor": {
      status: "ok",
      items: [post("2", 200, null), post("3", 100)],
      more_available: false,
    },
  });
  const context = await f.request({ kind: "context" });
  assert.equal(context.threadId, "saved-42");
  assert.equal(f.calls.length, 0);
  const s = session();
  await run(s, f);
  assert.equal(s.complete, true);
  assert.deepEqual(
    s.messages.map((m) => m.id),
    ["1", "2", "3"],
  );
  assert.equal(s.messages[0].caption, post("1").caption.text);
  assert.equal(s.messages[1].caption, "");
  assert.equal(s.messages[0].url, "https://www.instagram.com/p/code_1/");
  const { url, options } = f.calls[1];
  assert.equal(
    new URL(url, "https://www.instagram.com").pathname,
    "/api/v1/feed/saved/posts/",
  );
  assert.equal(
    new URL(url, "https://www.instagram.com").searchParams.get("max_id"),
    "next&cursor",
  );
  assert.equal(options.credentials, "include");
  assert.equal(options.redirect, "error");
  assert.equal(options.headers["X-CSRFToken"], "fixture-secret");
  assert.ok(!JSON.stringify(s).includes("fixture-secret"));
  const json = JSON.parse(jsonReport(s));
  assert.equal(json.kind, "saved-posts");
  assert.deepEqual(
    json.posts.map((p) => p.id),
    ["1", "2", "3"],
  );
  assert.equal(json.posts[0].caption, post("1").caption.text);
  assert.equal(json.posts[0].publishedAt, new Date(50000).toISOString());
  assert.equal("raw" in json.posts[0], false);
  assert.equal(
    "raw" in
      JSON.parse(jsonReport({ ...s, options: { ...s.options, raw: true } }))
        .posts[0],
    true,
  );
  assert.match(textReport(s), /\[No caption\]/);
  const html = htmlReport(s);
  assert.match(html, /Instagram saved posts/);
  assert.match(html, /href="https:\/\/www.instagram.com\/p\/code_1\/"/);
  assert.ok(html.includes("&lt;script&gt;markup&lt;/script&gt;"));
  assert.ok(!html.includes("<script>"));
});

test("saved post limits stop before fetching another page and empty libraries complete", async () => {
  const f = fixture({
    first: {
      status: "ok",
      items: [post("1"), post("2")],
      more_available: true,
      next_max_id: "next",
    },
  });
  const s = session({ limit: 1 });
  await run(s, f);
  assert.equal(s.messages.length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(s.complete, true);
  const empty = session();
  await run(
    empty,
    fixture({ first: { status: "ok", items: [], more_available: false } }),
  );
  assert.equal(empty.complete, true);
  assert.equal(empty.messages.length, 0);
});

test("failed saved-post pages preserve partial captions and resume from the last checkpoint", async () => {
  const pages = {
    first: {
      status: "ok",
      items: [post("1")],
      more_available: true,
      next_max_id: "next",
    },
    next: new Error("Network offline"),
  };
  const f = fixture(pages),
    s = session();
  await assert.rejects(run(s, f), /Network offline/);
  assert.equal(s.cursor, "next");
  assert.equal(s.messages.length, 1);
  assert.match(textReport(s), /PARTIAL EXPORT/);
  pages.next = { status: "ok", items: [post("2")], more_available: false };
  await run(s, f);
  assert.equal(s.complete, true);
  assert.equal(s.messages.length, 2);
  assert.equal(f.calls.length, 3);
});

test("unsupported saved responses, login failures, and cursor loops never report success", async () => {
  for (const page of [
    { status: "fail", message: "login_required" },
    { status: "ok", items: [], more_available: true, next_max_id: "next" },
    { status: "ok", items: [post("1")], more_available: true },
    {
      status: "ok",
      items: [post("1", 100, { unexpected: true })],
      more_available: false,
    },
    { status: "ok", items: [post("1", NaN)], more_available: false },
    { http: { ok: false, status: 403, headers: new Headers() } },
    {
      http: {
        ok: true,
        json: async () => {
          throw new Error("HTML login page");
        },
      },
    },
  ]) {
    const s = session();
    await assert.rejects(run(s, fixture({ first: page })));
    assert.equal(s.complete, false);
    assert.equal(s.cursor, null);
    assert.equal(s.messages.length, 0);
  }
  const s = session();
  await assert.rejects(
    run(
      s,
      fixture({
        first: {
          status: "ok",
          items: [post("1")],
          more_available: true,
          next_max_id: "loop",
        },
        loop: {
          status: "ok",
          items: [post("2")],
          more_available: true,
          next_max_id: "loop",
        },
      }),
    ),
    /pagination cursor/,
  );
  assert.equal(s.messages.length, 1);
  assert.equal(s.complete, false);
});

test("saved routing and serialized adapter reject wrong origins, collections and account changes", async () => {
  for (const path of ["/me/saved", "/me/saved/", "/me/saved/all-posts/"])
    assert.equal(
      platformForUrl("https://www.instagram.com" + path)?.id,
      "instagram-saved",
    );
  for (const url of [
    "https://www.instagram.com.evil.com/me/saved/",
    "http://www.instagram.com/me/saved/",
    "https://www.instagram.com/me/saved/a-collection/",
  ])
    assert.equal(platformForUrl(url), null);
  const f = fixture({});
  assert.match(
    (await f.request({ kind: "messages", threadId: "saved-other" })).error,
    /account changed/,
  );
  f.env.document.cookie = "";
  assert.match((await f.request({ kind: "context" })).error, /Sign in/);
  f.env.location.origin = "https://evil.example";
  assert.match((await f.request({ kind: "context" })).error, /Saved page/);
  assert.equal(f.calls.length, 0);
});

test("saved collections use their own feed and account/collection-bound checkpoint", async () => {
  const f = fixture({
    first: { status: "ok", items: [post("1")], more_available: false },
  });
  f.env.location.pathname = "/me/saved/travel/123/";
  const context = await f.request({ kind: "context" });
  assert.equal(context.threadId, "saved-42-123");
  assert.equal(context.collectionId, "123");
  const s = session({ threadId: context.threadId });
  await run(s, f);
  assert.match(f.calls[0].url, /^\/api\/v1\/feed\/collection\/123\//);
  f.env.location.pathname = "/me/saved/other/456/";
  assert.equal(
    (await f.request({ kind: "messages", threadId: context.threadId })).ok,
    false,
  );
  assert.equal(f.calls.length, 1);
});

test("collections can be chosen by name in Codex and pagination never exposes cookies", async () => {
  const f = fixture({
    first: {
      status: "ok",
      items: [
        {
          collection_id: "123",
          collection_name: "Food",
          collection_media_count: 2,
        },
      ],
      more_available: true,
      next_max_id: "next",
    },
  });
  const result = await f.request({ kind: "collections" });
  assert.equal(result.collections[0].name, "Food");
  assert.equal(result.collections[0].id, "123");
  assert.equal(result.nextCursor, "next");
  assert.match(f.calls[0].url, /^\/api\/v1\/collections\/list\//);
  assert.ok(!JSON.stringify(result).includes("fixture-secret"));
});
