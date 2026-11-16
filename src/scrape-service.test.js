import test from "node:test";
import assert from "node:assert/strict";
import { ScrapeService } from "./scrape-service.js";
import { sourceForUrl } from "./sources.js";

function fixture() {
  let updated;
  const tab = {
    id: 7,
    url: "https://web.whatsapp.com/",
    title: "WhatsApp",
    windowId: 1,
  };
  let context = "chat-1";
  let pages = 0;
  const browser = {
    tabs: {
      query: async () => [
        tab,
        { id: 8, url: "https://example.com/" },
        { ...tab, id: 9, incognito: true },
      ],
      get: async () => tab,
      onUpdated: {
        addListener: (fn) => {
          updated = fn;
        },
      },
      onRemoved: { addListener() {} },
    },
    permissions: { contains: async () => true },
    scripting: {
      executeScript: async ({ args }) => [
        {
          result:
            args[0].kind === "context"
              ? { ok: true, threadId: context, title: "Test chat" }
              : ++pages === 1
                ? { ok: false, status: 429, retryAfter: "1", error: "Busy" }
                : {
                    ok: true,
                    page: {
                      messages: [
                        {
                          id: "1",
                          timestamp: 1,
                          text: "<untrusted>",
                          raw: { private: "source" },
                        },
                      ],
                      hasMore: false,
                    },
                  },
        },
      ],
    },
  };
  return {
    service: new ScrapeService(browser, { sleep: async () => {} }),
    browser,
    tab,
    update: (change) => updated(7, change),
    changeChat: () => {
      context = "chat-2";
    },
  };
}
async function finished(service, jobId) {
  for (let i = 0; i < 50 && service.get(jobId).state === "running"; i++)
    await new Promise((resolve) => setImmediate(resolve));
  return service.get(jobId);
}

test("source discovery filters unsupported and incognito tabs; invalidates navigated selections", async () => {
  const f = fixture();
  const tabs = await f.service.listTabs();
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].operation, "conversation");
  assert.equal(tabs[0].hasAccess, true);
  f.update({ status: "loading" });
  await assert.rejects(
    f.service.describe(tabs[0].sourceId),
    /expired or changed/,
  );
  assert.equal(sourceForUrl("https://www.google.com.evil.com/maps"), null);
  assert.equal(
    sourceForUrl("https://www.google.com/maps/placelists/list/123").itemType,
    "place",
  );
  assert.equal(
    sourceForUrl("https://www.instagram.com/me/saved/travel/123/").itemType,
    "post",
  );
});

test("jobs reuse pagination retries, return structured partial-safe results, and omit raw internals", async () => {
  const { service } = fixture();
  const [tab] = await service.listTabs();
  const status = await service.start({ sourceId: tab.sourceId });
  assert.equal(status.state, "running");
  const job = await finished(service, status.jobId);
  assert.equal(job.state, "complete");
  const result = service.results({ jobId: job.id });
  assert.equal(result.items[0].text, "<untrusted>");
  assert.equal("raw" in result.items[0], false);
  assert.equal(result.complete, true);
  assert.equal(result.nextOffset, null);
  assert.throws(() => service.results({ jobId: job.id, limit: -1 }), /offset/);
  await service.handle("delete_job", { jobId: job.id });
  assert.throws(() => service.get(job.id), /not found/);
});

test("missing website permission and a changed conversation prevent collection", async () => {
  const f = fixture();
  const [tab] = await f.service.listTabs();
  await f.service.describe(tab.sourceId);
  f.changeChat();
  await assert.rejects(
    f.service.start({ sourceId: tab.sourceId }),
    /conversation or list changed/,
  );
  f.browser.permissions.contains = async () => false;
  await assert.rejects(f.service.describe(tab.sourceId), /access is missing/);
});

test("failed jobs preserve collected data and resume from their checkpoint", async () => {
  const f = fixture();
  let fail = true;
  f.browser.scripting.executeScript = async ({ args }) => {
    const request = args[0];
    if (request.kind === "context")
      return [{ result: { ok: true, threadId: "chat-1", title: "Chat" } }];
    if (request.cursor && fail) throw new Error("Offline");
    return [
      {
        result: {
          ok: true,
          page: {
            messages: [{ id: request.cursor ? "2" : "1", timestamp: 1 }],
            hasMore: !request.cursor,
            nextCursor: request.cursor ? null : "next",
          },
        },
      },
    ];
  };
  const [tab] = await f.service.listTabs();
  const status = await f.service.start({ sourceId: tab.sourceId });
  const job = await finished(f.service, status.jobId);
  assert.equal(job.state, "failed");
  assert.equal(f.service.results({ jobId: job.id }).items.length, 1);
  assert.equal(job.complete, false);
  fail = false;
  await f.service.handle("resume_job", { jobId: job.id });
  await finished(f.service, job.id);
  assert.equal(job.state, "complete");
  assert.equal(f.service.results({ jobId: job.id }).items.length, 2);
});

test("Maps jobs resolve place details in temporary tabs and always close them", async () => {
  const f = fixture();
  f.tab.url = "https://www.google.com/maps/placelists/list/123";
  const closed = [];
  f.browser.tabs.create = async () => ({ id: 10 });
  f.browser.tabs.get = async (id) =>
    id === 10
      ? {
          id,
          url: "https://www.google.com/maps/place/Cafe/",
          status: "complete",
        }
      : f.tab;
  f.browser.tabs.remove = async (id) => {
    closed.push(id);
  };
  f.browser.scripting.executeScript = async ({ target, args }) => [
    {
      result:
        target.tabId === 10
          ? {
              ok: true,
              entry: {
                name: "Cafe",
                address: "123 Main",
                hours: null,
                rating: 4.7,
                reviewCount: 100,
                unavailableFields: ["hours"],
              },
            }
          : args[0].kind === "context"
            ? { ok: true, threadId: "list-123", title: "Food" }
            : {
                ok: true,
                entries: [
                  {
                    name: "Cafe",
                    url: "https://www.google.com/maps/place/Cafe/",
                  },
                ],
                atEnd: true,
                expectedCount: 1,
              },
    },
  ];
  const [tab] = await f.service.listTabs();
  const status = await f.service.start({ sourceId: tab.sourceId });
  const job = await finished(f.service, status.jobId);
  assert.equal(job.state, "complete");
  assert.equal(f.service.results({ jobId: job.id }).items[0].rating, 4.7);
  assert.equal(job.warnings.length, 1);
  assert.deepEqual(closed, [10]);
});
