import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { instagramRequest } from "./instagram.js";
function environment(fetch) {
  return vm.createContext({
    location: {
      origin: "https://www.instagram.com",
      pathname: "/direct/t/123/",
    },
    document: {
      title: "Instagram",
      cookie: "csrftoken=fixture-csrf; ds_user_id=42",
      scripts: [
        {
          textContent:
            '["DTSGInitialData",[],{"token":"fixture-dtsg"}],["LSD",[],{"token":"fixture-lsd"}]',
        },
      ],
    },
    window: {},
    fetch,
    AbortSignal,
    URLSearchParams,
  });
}
test("page adapter authenticates only against Instagram and never returns tokens", async () => {
  let called = false;
  const env = environment(async (url, options) => {
    called = true;
    assert.equal(url, "/api/graphql");
    assert.equal(options.credentials, "include");
    const body = new URLSearchParams(options.body);
    assert.equal(body.get("fb_dtsg"), "fixture-dtsg");
    assert.equal(JSON.parse(body.get("variables")).id, "123");
    return {
      ok: true,
      json: async () => ({
        data: {
          fetch__SlideThread: {
            as_ig_direct_thread: {
              slide_messages: {
                edges: [],
                page_info: { has_next_page: false },
              },
            },
          },
        },
      }),
    };
  });
  const out = await vm.runInContext(
    `(${instagramRequest.toString()})({kind:'messages',queryId:'123'})`,
    env,
  );
  assert.equal(called, true);
  assert.equal(out.ok, true);
  assert.equal(out.viewerId, "42");
  assert.ok(!JSON.stringify(out).includes("fixture-"));
});
test("page adapter rejects GraphQL errors and thread changes", async () => {
  const env = environment(async () => ({
    ok: true,
    json: async () => ({ errors: [{ message: "Query unavailable" }] }),
  }));
  const out = await vm.runInContext(
    `(${instagramRequest.toString()})({kind:'messages',queryId:'123'})`,
    env,
  );
  assert.match(out.error, /Query unavailable/);
  const changed = await vm.runInContext(
    `(${instagramRequest.toString()})({kind:'messages',threadId:'999'})`,
    env,
  );
  assert.match(changed.error, /changed conversations/);
});
