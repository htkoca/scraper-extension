import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { SourceManager } from "./source-manager.js";
import { discoverRequest } from "./discovery.js";

function fixture(candidates) {
  const tabs = new Map();
  const closed = [];
  let counter = 10;
  const service = {
    sources: new Map(),
    jobs: new Map(),
    sleep: async () => {},
    browser: {
      permissions: { contains: async () => true },
      tabs: {
        create: async ({ url, active }) => {
          assert.equal(active, false);
          const tab = { id: ++counter, url, status: "complete" };
          tabs.set(tab.id, tab);
          return tab;
        },
        get: async (id) => {
          if (!tabs.has(id)) throw new Error("Missing");
          return tabs.get(id);
        },
        remove: async (id) => {
          closed.push(id);
          tabs.delete(id);
        },
      },
    },
    execute: async () => ({ ok: true, candidates, nextCursor: null }),
    describe: async (sourceId) => ({
      sourceId,
      title: service.sources.get(sourceId).title,
    }),
  };
  return { service, manager: new SourceManager(service), tabs, closed };
}
test("service URL opens an authenticated-background source and release only closes owned tabs", async () => {
  const f = fixture([]);
  const result = await f.manager.prepare({
    service: "google-maps",
    url: "https://www.google.com/maps/placelists/list/123",
  });
  assert.ok(result.sourceId);
  await f.manager.release(result.sourceId);
  assert.deepEqual(f.closed, [11]);
  f.service.sources.set("user-source", { tabId: 7 });
  await f.manager.release("user-source");
  assert.deepEqual(f.closed, [11]);
  await assert.rejects(
    f.manager.prepare({ service: "google-maps", url: "https://evil.com/maps" }),
    /does not match/,
  );
});
test("exact named sources resolve, duplicate names return choices, and WhatsApp uses a target ID", async () => {
  const candidates = [
    { id: "123@c.us", name: "Alice", url: "https://web.whatsapp.com/" },
  ];
  const f = fixture(candidates);
  const result = await f.manager.prepare({
    service: "whatsapp",
    name: "Alice",
  });
  assert.equal(f.service.sources.get(result.sourceId).targetId, "123@c.us");
  assert.equal(f.tabs.size, 1);
  candidates.push({ ...candidates[0], id: "456@c.us" });
  const ambiguous = await f.manager.prepare({
    service: "whatsapp",
    name: "Alice",
  });
  assert.equal(ambiguous.needsSelection, true);
  assert.equal(ambiguous.candidates.length, 2);
  f.service.browser.permissions.contains = async () => false;
  await assert.rejects(
    f.manager.discover({ service: "whatsapp" }),
    /Enable this website/,
  );
});
test("Instagram conversation discovery returns existing users and cursor without credentials", async () => {
  const env = vm.createContext({
    location: { origin: "https://www.instagram.com" },
    document: { cookie: "csrftoken=secret; ds_user_id=42" },
    URLSearchParams,
    AbortSignal,
    fetch: async (url) => {
      assert.match(url, /direct_v2\/inbox/);
      return {
        ok: true,
        json: async () => ({
          status: "ok",
          inbox: {
            threads: [
              {
                thread_id: "123",
                thread_title: "Alice",
                users: [{ username: "alice" }],
              },
            ],
            has_older: true,
            oldest_cursor: "next",
          },
        }),
      };
    },
  });
  const result = await vm.runInContext(
    `(${discoverRequest.toString()})({service:'instagram'})`,
    env,
  );
  assert.equal(
    result.candidates[0].url,
    "https://www.instagram.com/direct/t/123/",
  );
  assert.equal(result.nextCursor, "next");
  assert.ok(!JSON.stringify(result).includes("secret"));
});
