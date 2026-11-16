import { SourceManager } from "./source-manager.js";
import { sourceForUrl, siteOrigins } from "./sources.js";
import { getPlatform } from "./platforms.js";
import { createSession } from "./model.js";
import { fetchHistory, wait } from "./runner.js";
import { mapsListRequest, mapsPlaceRequest } from "./google-maps.js";

export class ScrapeService {
  constructor(browser, { sleep = wait } = {}) {
    this.browser = browser;
    this.sleep = sleep;
    this.sources = new Map();
    this.jobs = new Map();
    this.manager = new SourceManager(this);
    browser.tabs.onUpdated.addListener((id, change) => {
      if (change.status === "loading" || change.url) this.invalidate(id);
    });
    browser.tabs.onRemoved.addListener((id) => this.invalidate(id));
  }
  invalidate(tabId) {
    for (const source of this.sources.values())
      if (source.tabId === tabId) source.stale = true;
  }
  async execute(tabId, func, request, allowFailure = false) {
    const [result] = await this.browser.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func,
      args: [request],
    });
    if (!result?.result || (!result.result.ok && !allowFailure))
      throw new Error(result?.result?.error || "The page did not respond.");
    return result.result;
  }
  async listTabs() {
    const tabs = await this.browser.tabs.query({});
    // A fresh discovery replaces old selections, but never invalidates running jobs.
    for (const [id, source] of this.sources)
      if (!source.inUse) this.sources.delete(id);
    return Promise.all(
      tabs
        .filter((tab) => !tab.incognito && sourceForUrl(tab.url))
        .map(async (tab) => {
          const adapter = sourceForUrl(tab.url);
          const origins =
            siteOrigins[
              adapter.id === "instagram-saved" ? "instagram" : adapter.id
            ];
          const hasAccess = await this.browser.permissions.contains({
            origins,
          });
          const sourceId = crypto.randomUUID();
          this.sources.set(sourceId, {
            sourceId,
            tabId: tab.id,
            url: tab.url,
            adapter,
            title: tab.title,
          });
          return {
            sourceId,
            tabId: tab.id,
            windowId: tab.windowId,
            title: tab.title,
            url: tab.url,
            ...adapter,
            hasAccess,
            accessSetup: hasAccess
              ? null
              : "Open the extension options and enable this website. Do not select the tab again in Chrome.",
          };
        }),
    );
  }
  async selected(sourceId) {
    const source = this.sources.get(sourceId);
    if (!source || source.stale)
      throw new Error("Source expired or changed. List tabs and select again.");
    const tab = await this.browser.tabs.get(source.tabId);
    if (tab.url !== source.url)
      throw new Error(
        "The selected tab navigated. List tabs and select again.",
      );
    const origins =
      siteOrigins[
        source.adapter.id === "instagram-saved"
          ? "instagram"
          : source.adapter.id
      ];
    if (!(await this.browser.permissions.contains({ origins })))
      throw new Error(
        "Website access is missing. Enable it in extension options; tab selection stays in your agent.",
      );
    return source;
  }
  async describe(sourceId, options = {}) {
    const source = await this.selected(sourceId);
    const context = await this.execute(
      source.tabId,
      source.adapter.id === "google-maps"
        ? mapsListRequest
        : getPlatform(source.adapter.id).request,
      {
        kind: "context",
        collectionId: options.collectionId,
        targetId: source.targetId,
      },
    );
    if (
      source.context &&
      source.context.threadId !== context.threadId &&
      source.collectionId === options.collectionId
    )
      throw new Error(
        "The selected conversation or list changed. List tabs and select again.",
      );
    source.context = context;
    source.collectionId = options.collectionId;
    return {
      sourceId,
      ...source.adapter,
      title: context.title,
      sourceIdentity: context.threadId,
      options:
        source.adapter.id === "instagram-saved"
          ? ["collectionId", "limit"]
          : source.adapter.id === "google-maps"
            ? ["limit"]
            : ["limit", "start", "end"],
      warnings: context.warnings || [],
    };
  }
  status(job) {
    return {
      jobId: job.id,
      state: job.state,
      source: job.source.adapter.id,
      title: job.title,
      count: job.session?.messages.length ?? job.items.length,
      complete: job.complete,
      progress: job.progress,
      error: job.error || null,
      warnings: job.warnings.slice(0, 100),
      warningCount: job.warnings.length,
    };
  }
  async start({ sourceId, options = {} }) {
    if (
      [...this.jobs.values()].filter((job) => job.state === "running").length >=
      2
    )
      throw new Error("Two jobs are already running. Wait or cancel one.");
    if (this.jobs.size >= 20)
      throw new Error(
        "Delete an old job with delete_job before starting another.",
      );
    const source = await this.selected(sourceId);
    if (
      [...this.jobs.values()].some(
        (job) => job.source.tabId === source.tabId && job.state === "running",
      )
    )
      throw new Error("A job is already using this tab.");
    await this.describe(sourceId, options);
    if (
      options.limit != null &&
      (!Number.isSafeInteger(options.limit) || options.limit < 1)
    )
      throw new Error("limit must be a positive integer.");
    if (
      (options.start != null && !Number.isFinite(options.start)) ||
      (options.end != null && !Number.isFinite(options.end))
    )
      throw new Error("Dates must be epoch milliseconds.");
    if (
      options.start != null &&
      options.end != null &&
      options.start > options.end
    )
      throw new Error("The start date must precede the end date.");
    if (
      source.adapter.operation !== "conversation" &&
      (options.start != null || options.end != null)
    )
      throw new Error("Date filters apply only to conversations.");
    const job = {
      id: crypto.randomUUID(),
      source: { ...source },
      title: source.context.title,
      items: [],
      warnings: [...(source.context.warnings || [])],
      state: "running",
      complete: false,
      progress: "Starting",
      options,
      controller: new AbortController(),
    };
    source.inUse = true;
    if (source.adapter.id !== "google-maps")
      job.session = createSession({
        platform: source.adapter.id,
        start: null,
        end: null,
        ...options,
        threadId: source.context.threadId,
      });
    this.jobs.set(job.id, job);
    this.run(job);
    return this.status(job);
  }
  async check(job) {
    job.controller.signal.throwIfAborted();
    await this.selected(job.source.sourceId);
  }
  async run(job) {
    try {
      if (job.source.adapter.id === "google-maps") await this.collectMaps(job);
      else
        await fetchHistory(job.session, {
          signal: job.controller.signal,
          sleep: this.sleep,
          progress: (text) => {
            job.progress = text;
          },
          request: async (request) => {
            await this.check(job);
            const result = await this.execute(
              job.source.tabId,
              getPlatform(job.source.adapter.id).request,
              { ...request, targetId: job.source.targetId },
              true,
            );
            await this.check(job);
            return result;
          },
        });
      job.complete =
        job.source.adapter.id === "google-maps"
          ? job.listComplete
          : job.session.complete;
      job.state = job.complete ? "complete" : "partial";
      job.progress = job.complete
        ? "Finished"
        : "Finished with incomplete coverage";
    } catch (error) {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.error = error.message;
    }
  }
  async collectMaps(job) {
    const signal = job.controller.signal;
    if (!job.places) {
      const places = (job.discoveredPlaces ||= new Map());
      let stable = 0,
        expected = null;
      const started = Date.now();
      while (stable < 4) {
        await this.check(job);
        if (Date.now() - started > 300000)
          throw new Error(
            "List discovery timed out. The job is partial; retry after Maps finishes loading.",
          );
        const page = await this.execute(job.source.tabId, mapsListRequest, {
          kind: "entries",
          fingerprint: job.source.context.threadId,
          reset: !job.scanStarted,
        });
        job.scanStarted = true;
        const previous = places.size;
        for (const entry of page.entries) places.set(entry.url, entry);
        expected = page.expectedCount ?? expected;
        stable = page.atEnd && previous === places.size ? stable + 1 : 0;
        job.progress = `Found ${places.size} places`;
        if (job.options.limit && places.size >= job.options.limit) break;
        await this.sleep(800, signal);
      }
      job.places = [...places.values()].slice(
        0,
        job.options.limit || undefined,
      );
      job.listComplete =
        Boolean(job.options.limit && places.size >= job.options.limit) ||
        (expected !== null && places.size === expected);
      if (!job.listComplete)
        job.warnings.push(
          "Maps stopped loading more places, but did not expose a matching total. Coverage is unverified; results are marked partial.",
        );
    }
    for (let i = job.items.length; i < job.places.length; i++) {
      await this.check(job);
      const place = job.places[i];
      let detailTab;
      try {
        detailTab = await this.browser.tabs.create({
          url: place.url,
          active: false,
        });
        // Wait for the new document before injecting; about:blank is not scriptable with site permissions.
        const started = Date.now();
        while (true) {
          signal.throwIfAborted();
          const tab = await this.browser.tabs.get(detailTab.id);
          if (
            tab.status === "complete" &&
            sourceForUrl(tab.url)?.id === "google-maps"
          )
            break;
          if (Date.now() - started > 30000)
            throw new Error("Place tab did not load within 30 seconds.");
          await this.sleep(300, signal);
        }
        const result = await this.execute(detailTab.id, mapsPlaceRequest, {});
        await this.check(job);
        job.items.push({ ...result.entry, id: place.url, type: "place" });
        if (result.entry.unavailableFields.length)
          job.warnings.push(
            `${result.entry.name}: unavailable ${result.entry.unavailableFields.join(", ")}`,
          );
      } finally {
        if (detailTab)
          await this.browser.tabs.remove(detailTab.id).catch(() => {});
      }
      job.progress = `${job.items.length} / ${job.places.length} places`;
      await this.sleep(600, signal);
    }
  }
  get(jobId) {
    const job = this.jobs.get(jobId);
    if (!job)
      throw new Error(
        "Job not found. Jobs are cleared when the extension restarts or is disconnected.",
      );
    return job;
  }
  results({ jobId, offset = 0, limit = 25 }) {
    const job = this.get(jobId);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("Use offset >= 0 and limit between 1 and 100.");
    const all = job.session?.messages || job.items;
    const items = [];
    let bytes = 0;
    for (const original of all.slice(offset, offset + limit)) {
      const { raw, ...item } = original;
      const size = new TextEncoder().encode(JSON.stringify(item)).length;
      if (bytes + size > 600000) break;
      bytes += size;
      items.push(item);
    }
    if (!items.length && offset < all.length)
      throw new Error(
        "An individual item exceeds the bridge response limit. Use the manual exporter for this source.",
      );
    return {
      ...this.status(job),
      itemType: job.source.adapter.itemType,
      offset,
      items,
      nextOffset:
        offset + items.length < all.length ? offset + items.length : null,
    };
  }
  async handle(method, params = {}) {
    if (method === "browser_info")
      return {
        profile:
          (await this.browser.storage.local.get("bridgeProfile"))
            .bridgeProfile || null,
      };
    if (method === "discover_sources") return this.manager.discover(params);
    if (method === "prepare_source") return this.manager.prepare(params);
    if (method === "release_source")
      return this.manager.release(params.sourceId);
    if (method === "list_tabs") return this.listTabs();
    if (method === "describe_source")
      return this.describe(params.sourceId, params.options);
    if (method === "list_collections") {
      const source = await this.selected(params.sourceId);
      if (source.adapter.id !== "instagram-saved")
        throw new Error(
          "Collection discovery is supported on Instagram Saved tabs. Open a Maps list directly.",
        );
      const result = await this.execute(
        source.tabId,
        getPlatform(source.adapter.id).request,
        {
          kind: "collections",
          cursor: params.cursor,
          threadId: source.context?.threadId,
          collectionId: source.collectionId,
        },
      );
      return { collections: result.collections, nextCursor: result.nextCursor };
    }
    if (method === "start_scrape") return this.start(params);
    if (method === "get_status") return this.status(this.get(params.jobId));
    if (method === "get_results") return this.results(params);
    if (method === "cancel_job") {
      const job = this.get(params.jobId);
      job.controller.abort(new Error("Cancelled by caller"));
      return this.status(job);
    }
    if (method === "delete_job") {
      const job = this.get(params.jobId);
      if (job.state === "running")
        throw new Error("Cancel the job and wait for it to stop first.");
      this.jobs.delete(job.id);
      const source = this.sources.get(job.source.sourceId);
      if (source && !source.managed) source.inUse = false;
      return { deleted: true };
    }
    if (method === "resume_job") {
      const job = this.get(params.jobId);
      if (!["failed", "cancelled"].includes(job.state))
        throw new Error("Only failed or cancelled jobs can resume.");
      await this.check({ ...job, controller: new AbortController() });
      job.controller = new AbortController();
      job.state = "running";
      job.error = null;
      this.run(job);
      return this.status(job);
    }
    throw new Error("Unknown bridge method.");
  }
}
