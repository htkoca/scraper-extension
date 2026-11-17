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
        query: async () => [...tabs.values()],
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

test("Maps discovers and selects button-based saved lists without place links", async () => {
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(
    '<html><body><button aria-label="Date Shared · 22 places"></button><button aria-label="Check out Private · 4 places"></button></body></html>',
  );
  const location = new URL("https://www.google.com/maps/");
  const env = vm.createContext({
    document,
    location,
    URL,
    setTimeout: (fn) => fn(),
  });
  const run = (request) =>
    vm.runInContext(
      `(${discoverRequest.toString()})(${JSON.stringify(request)})`,
      env,
    );
  const found = await run({ service: "google-maps" });
  assert.equal(found.candidates[0].name, "Date");
  assert.equal(found.candidates[1].name, "Check out");
  document.querySelector("button").click = () => {
    location.href =
      "https://www.google.com/maps/@1,2,3z/data=!11m2!2slist-identity!3e3";
  };
  const selected = await run({
    service: "google-maps",
    select: found.candidates[0].select,
  });
  assert.match(selected.url, /list-identity/);
});

test("Instagram collection API 404 falls back to rendered Saved collection links", async () => {
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(
    '<html><body><a href="https://www.instagram.com/tony/saved/events/123/">Events</a><a href="https://www.instagram.com/tony/saved/dates/456/">Date spots</a></body></html>',
  );
  document.cookie = "csrftoken=secret; ds_user_id=42";
  const env = vm.createContext({
    document,
    location: new URL("https://www.instagram.com/tony/saved/"),
    URL,
    URLSearchParams,
    AbortSignal,
    fetch: async () => ({ ok: false, status: 404 }),
  });
  const result = await vm.runInContext(
    `(${discoverRequest.toString()})({service:'instagram-saved'})`,
    env,
  );
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].name, "Events");
  assert.match(result.warnings[0], /coverage is unverified/);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("Instagram discovery navigates only to the signed-in profile's rendered Saved URL", async () => {
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(
    '<html><body><a href="https://www.instagram.com/tony/" aria-label="Profile">Profile</a></body></html>',
  );
  document.cookie = "csrftoken=secret; ds_user_id=42";
  const env = vm.createContext({
    document,
    location: new URL("https://www.instagram.com/"),
    URL,
    URLSearchParams,
    AbortSignal,
    fetch: async () => ({ ok: false, status: 404 }),
  });
  const result = await vm.runInContext(
    `(${discoverRequest.toString()})({service:'instagram-saved'})`,
    env,
  );
  assert.equal(result.navigate, "https://www.instagram.com/tony/saved/");
  assert.equal(result.pending, true);
});

test("empty WhatsApp models wait for the linked browser to finish loading", async () => {
  const env = vm.createContext({
    location: new URL("https://web.whatsapp.com/"),
    window: { require: () => ({ Chat: { getModelsArray: () => [] } }) },
  });
  const result = await vm.runInContext(
    `(${discoverRequest.toString()})({service:'whatsapp'})`,
    env,
  );
  assert.equal(result.pending, true);
});

test("named Maps button candidates open a fresh source and wait for its heading", async () => {
  const f = fixture([
    {
      id: "Date Shared · 22 places",
      name: "Date",
      url: "https://www.google.com/maps/",
      select: "Date Shared · 22 places",
    },
  ]);
  const calls = [];
  f.service.execute = async (_id, _func, request) => {
    calls.push(request);
    return request.select
      ? {
          ok: true,
          url: "https://www.google.com/maps/@1,2,3z/data=!11m2!2sdate!3e3",
        }
      : {
          candidates: [
            {
              id: "Date Shared · 22 places",
              name: "Date",
              url: "https://www.google.com/maps/",
              select: "Date Shared · 22 places",
            },
          ],
        };
  };
  let attempts = 0;
  f.service.describe = async (sourceId) => {
    if (++attempts === 1)
      throw new Error(
        "Open the saved list itself, with its places visible, rather than a place detail or search.",
      );
    return { sourceId, title: "Date" };
  };
  const result = await f.manager.prepare({
    service: "google-maps",
    name: "Date",
  });
  assert.equal(result.title, "Date");
  assert.equal(attempts, 2);
  assert.equal(f.tabs.size, 2);
  assert.equal(calls[1].select, "Date Shared · 22 places");
});

test("Instagram Saved hash links never restart same-page discovery", async () => {
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(
    '<html><body><a href="https://www.instagram.com/tony/saved/#">tony</a><a href="https://www.instagram.com/tony/saved/">Saved</a></body></html>',
  );
  document.cookie = "csrftoken=secret; ds_user_id=42";
  const env = vm.createContext({
    document,
    location: new URL("https://www.instagram.com/tony/saved/"),
    URL,
    URLSearchParams,
    AbortSignal,
    fetch: async () => ({ ok: false, status: 404 }),
  });
  const result = await vm.runInContext(
    `(${discoverRequest.toString()})({service:'instagram-saved'})`,
    env,
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 404 and no collection links/);
  assert.equal(result.navigate, undefined);
});

test("discovery reuses an existing signed-in tab and returns stable source IDs", async () => {
  const f = fixture([
    {
      id: "123",
      name: "Events",
      url: "https://www.instagram.com/me/saved/events/123/",
    },
  ]);
  f.tabs.set(7, {
    id: 7,
    url: "https://www.instagram.com/direct/inbox/",
    status: "complete",
  });
  f.tabs.set(8, { id: 8, url: "https://www.instagram.com/", incognito: true });
  let used;
  f.service.execute = async (id) => {
    used = id;
    return {
      ok: true,
      candidates: [
        {
          id: "123",
          name: "Events",
          url: "https://www.instagram.com/me/saved/events/123/",
        },
      ],
      nextCursor: null,
    };
  };
  const result = await f.manager.discover({ service: "instagram-saved" });
  assert.equal(used, 7);
  assert.equal(result.candidates[0].id, "123");
  assert.equal(f.tabs.size, 2);
  assert.equal(f.manager.owned.size, 0);
});

test("preparing the same Maps list reuses its user-owned tab across map movement", async () => {
  const f = fixture([]);
  f.tabs.set(7, {
    id: 7,
    url: "https://www.google.com/maps/@1,2,3z/data=!11m2!2sdate!3e3",
    status: "complete",
  });
  const result = await f.manager.prepare({
    service: "google-maps",
    url: "https://www.google.com/maps/@4,5,6z/data=!11m2!2sdate!3e3?hl=en",
  });
  assert.equal(f.service.sources.get(result.sourceId).tabId, 7);
  await f.manager.release(result.sourceId);
  assert.equal(f.tabs.size, 1);
  assert.deepEqual(f.closed, []);
});

test("discovery opens a background tab instead of navigating a user's tab", async () => {
  const f = fixture([]);
  f.tabs.set(7, {
    id: 7,
    url: "https://www.instagram.com/",
    status: "complete",
  });
  let calls = 0;
  f.service.execute = async () =>
    ++calls === 1
      ? {
          ok: true,
          navigate: "https://www.instagram.com/me/saved/",
          pending: true,
        }
      : { ok: true, candidates: [], nextCursor: null };
  await f.manager.discover({ service: "instagram-saved" });
  assert.equal(f.tabs.get(7).url, "https://www.instagram.com/");
  assert.equal(f.tabs.size, 2);
  assert.equal(f.tabs.get(11).url, "https://www.instagram.com/me/saved/");
});

test("release retains a reused owned tab until its last source is released", async () => {
  const f = fixture([]);
  const tab = await f.manager.open(
    "https://www.google.com/maps/placelists/list/123",
  );
  f.service.sources.set("first", { tabId: tab.id });
  f.service.sources.set("second", { tabId: tab.id });
  await f.manager.release("first");
  assert.deepEqual(f.closed, []);
  await f.manager.release("second");
  assert.deepEqual(f.closed, [tab.id]);
});

test("named sources search subsequent discovery pages before declaring no match", async () => {
  const f = fixture([]);
  f.service.execute = async (_tab, _fn, request) => ({
    ok: true,
    candidates: request.cursor
      ? [{ id: "target@c.us", name: "Alice", url: "https://web.whatsapp.com/" }]
      : [{ id: "other@c.us", name: "Bob", url: "https://web.whatsapp.com/" }],
    nextCursor: request.cursor ? null : "next",
  });
  const result = await f.manager.prepare({
    service: "whatsapp",
    name: "Alice",
  });
  assert.equal(f.service.sources.get(result.sourceId).targetId, "target@c.us");
});

test("Maps discovers actual icon-bearing navigation and concatenated list labels", async () => {
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(
    '<html><body><button jsaction="navigationrail.saved"><span class="google-symbols" aria-hidden="true">icon</span><div>Saved</div></button></body></html>',
  );
  const env = vm.createContext({
    document,
    location: new URL("https://www.google.com/maps/"),
    URL,
    setTimeout: (fn) => fn(),
  });
  document.querySelector("button").click = () => {
    document.body.innerHTML =
      '<button><span class="google-symbols" aria-hidden="true">icon</span><div>Date</div><div>Shared · 22 places</div></button>';
  };
  const run = () =>
    vm.runInContext(
      `(${discoverRequest.toString()})({service:"google-maps"})`,
      env,
    );
  assert.equal((await run()).pending, true);
  const result = await run();
  assert.equal(result.candidates[0].name, "Date");
});

test("Maps discovery rejects account links containing a list URL in their query", async () => {
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(
    '<html><body><a href="https://accounts.google.com/SignOutOptions?continue=https://www.google.com/maps/data=!11m2!2slist">Account</a><button jsaction="navigationrail.saved">Saved</button></body></html>',
  );
  document.querySelector("button").click = () => {};
  const env = vm.createContext({
    document,
    location: new URL("https://www.google.com/maps/"),
    URL,
  });
  const result = await vm.runInContext(
    `(${discoverRequest.toString()})({service:"google-maps"})`,
    env,
  );
  assert.equal(result.pending, true);
  assert.equal(result.candidates.length, 0);
});

test("Maps discovery activates its reused tab at most once when hidden rendering stalls", async () => {
  const f = fixture([]);
  f.tabs.set(7, {
    id: 7,
    url: "https://www.google.com/maps/",
    status: "complete",
  });
  let activated = 0;
  f.service.browser.tabs.update = async (id, options) => {
    assert.equal(id, 7);
    assert.equal(options.active, true);
    activated++;
  };
  f.service.execute = async () =>
    activated
      ? {
          ok: true,
          candidates: [
            {
              id: "DateShared · 22 places",
              name: "Date",
              url: "https://www.google.com/maps/",
              select: "DateShared · 22 places",
            },
          ],
          nextCursor: null,
        }
      : { ok: true, pending: true, candidates: [] };
  const result = await f.manager.discover({ service: "google-maps" });
  assert.equal(result.candidates[0].name, "Date");
  assert.equal(activated, 1);
  assert.match(result.warnings[0], /activating/);
  assert.equal(f.tabs.size, 1);
});
