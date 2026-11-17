import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import {
  InstagramApi,
  instagramGraphqlRequest,
  instagramAccountContext,
} from "./instagram-api.js";

function pageFixture(response) {
  const { document } = parseHTML(
    '<html><head></head><body><a href="https://www.instagram.com/tony/" aria-label="Profile">Profile</a></body></html>',
  );
  document.scripts = [];
  document.cookie = "csrftoken=private-csrf; ds_user_id=42";
  const calls = [];
  const env = vm.createContext({
    document,
    location: new URL("https://www.instagram.com/tony/saved/"),
    URL,
    URLSearchParams,
    AbortSignal,
    window: {
      require: (name) => ({
        token: name === "LSD" ? "private-lsd" : "private-dtsg",
      }),
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, text: async () => JSON.stringify(response) };
    },
  });
  return {
    calls,
    run: (fn, request = {}) =>
      vm.runInContext(`(${fn.toString()})(${JSON.stringify(request)})`, env),
  };
}

test("Instagram auth and GraphQL fetch stay in the selected page and never return tokens", async () => {
  const f = pageFixture({ data: { viewer: {} } });
  const result = await f.run(instagramGraphqlRequest, {
    friendly: "PolarisProfileSavedTabContentQuery",
    fallbackId: "27584326974521636",
    variables: { first: 12 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.transport, "source-tab");
  assert.equal(result.viewerId, "42");
  assert.equal(result.username, "tony");
  assert.equal(f.calls[0].url, "/api/graphql");
  assert.equal(f.calls[0].options.credentials, "include");
  assert.equal(
    new URLSearchParams(f.calls[0].options.body).get("fb_dtsg"),
    "private-dtsg",
  );
  assert.ok(!JSON.stringify(result).includes("private-"));
  const account = await f.run(instagramAccountContext);
  assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(account).includes("private-"));
});

test("Instagram source-page auth rejection is explicit rather than an empty success", async () => {
  const f = pageFixture({ error: 1357004 });
  const result = await f.run(instagramGraphqlRequest, {
    friendly: "query",
    fallbackId: "1",
    variables: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /1357004/);
});

test("Saved discovery preserves stable IDs, counts, pagination and known automatic collections", async () => {
  const calls = [];
  const api = new InstagramApi({
    execute: async (tabId, fn, request) => {
      calls.push({ tabId, fn, request });
      return {
        ok: true,
        username: "tony",
        transport: "source-tab",
        warnings: [],
        data: {
          viewer: {
            collections_unified_with_auto_collections: {
              edges: [
                { node: { __typename: "IGAllMediaAutoCollection" } },
                { node: { __typename: "XDTAudioAutoCollection" } },
                {
                  node: {
                    __typename: "MediaCollection",
                    collection_id: "123",
                    collection_name: "Events",
                    collection_media_count: 33,
                  },
                },
              ],
              page_info: { has_next_page: true, end_cursor: "11" },
            },
          },
        },
      };
    },
  });
  const result = await api.discover(7);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, "123");
  assert.equal(result.candidates[0].count, 33);
  assert.equal(result.nextCursor, "11");
  assert.equal(calls[0].tabId, 7);
  assert.equal(calls[0].fn, instagramGraphqlRequest);
  assert.equal(calls[0].request.fallbackId, "27584326974521636");
  await assert.rejects(api.discover(7, "11"), /did not advance/);
});

test("Saved contents preserve exact captions and explicitly unknown publication dates", async () => {
  const api = new InstagramApi({
    execute: async (tabId, fn, request) => {
      assert.equal(tabId, 7);
      assert.equal(request.fallbackId, "39910535158594768");
      assert.equal(request.variables.collection_id, "123");
      return {
        ok: true,
        transport: "source-tab",
        data: {
          fetch__MediaCollection: {
            id: "123",
            name: "Events",
            media: {
              edges: [
                {
                  node: {
                    pk: "456",
                    code: "abc",
                    caption: { text: "Exact\ncaption 🥂" },
                    user: { username: "author", pk: "12" },
                  },
                },
              ],
              page_info: { has_next_page: false, end_cursor: "last" },
            },
          },
        },
      };
    },
  });
  const result = await api.posts(7, "123");
  assert.equal(result.page.messages[0].timestamp, null);
  assert.equal(result.page.messages[0].caption, "Exact\ncaption 🥂");
  assert.equal(result.page.hasMore, false);
});
