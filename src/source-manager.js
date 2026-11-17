import { discoverRequest } from "./discovery.js";
import { siteOrigins, sourceForUrl, sameSourceUrl } from "./sources.js";

const home = {
  instagram: "https://www.instagram.com/direct/inbox/",
  "instagram-saved": "https://www.instagram.com/",
  whatsapp: "https://web.whatsapp.com/",
  "google-maps": "https://www.google.com/maps/?hl=en",
};
export class SourceManager {
  constructor(service) {
    this.service = service;
    this.browser = service.browser;
    this.owned = new Set();
    this.candidates = new Map();
    this.serviceTabs = new Map();
  }
  async access(service) {
    if (!home[service]) throw new Error("Unsupported service.");
    const origins =
      siteOrigins[service === "instagram-saved" ? "instagram" : service];
    if (!(await this.browser.permissions.contains({ origins })))
      throw new Error(
        "Enable this website in extension options once. No tab selection is required.",
      );
  }
  async open(url) {
    const tab = await this.browser.tabs.create({ url, active: false });
    this.owned.add(tab.id);
    try {
      for (let i = 0; i < 50; i++) {
        const current = await this.browser.tabs.get(tab.id);
        if (current.status === "complete") return current;
        await this.service.sleep(300);
      }
      throw new Error(
        "Service is still loading. Retry discovery; the background tab is retained for login.",
      );
    } catch (error) {
      throw new Error(`${error.message} Tab ${tab.id}.`);
    }
  }
  async findTab(service, url) {
    const tabs = await this.browser.tabs.query({});
    return tabs
      .filter(
        (tab) =>
          this.matchesService(tab, service) &&
          (!url || sameSourceUrl(tab.url, url)),
      )
      .sort(
        (a, b) =>
          Number(Boolean(a.discarded)) - Number(Boolean(b.discarded)) ||
          Number(Boolean(b.active)) - Number(Boolean(a.active)) ||
          (b.lastAccessed || 0) - (a.lastAccessed || 0),
      )[0];
  }
  matchesService(tab, service) {
    if (!tab || tab.incognito) return false;
    try {
      const url = new URL(tab.url);
      return service.startsWith("instagram")
        ? url.origin === "https://www.instagram.com"
        : sourceForUrl(tab.url)?.id === service;
    } catch {
      return false;
    }
  }
  async discover({ service, cursor }) {
    await this.access(service);
    let tab;
    const existing = this.serviceTabs.get(service);
    if (existing) tab = await this.browser.tabs.get(existing).catch(() => null);
    if (tab && !this.matchesService(tab, service)) tab = null;
    if (!tab) {
      tab = (await this.findTab(service)) || (await this.open(home[service]));
      this.serviceTabs.set(service, tab.id);
    }
    let result;
    let activated = false;
    for (let i = 0; i < 10; i++) {
      if (service === "google-maps" && i === 3 && this.browser.tabs.update) {
        await this.browser.tabs.update(tab.id, { active: true });
        activated = true;
      }
      result =
        service === "instagram-saved" && this.service.instagram
          ? await this.service.instagram.discover(tab.id, cursor)
          : await this.service.execute(
              tab.id,
              discoverRequest,
              { service, cursor },
              true,
            );
      if (!result.ok && result.ok !== undefined) {
        if (
          i < 9 &&
          /did not expose|still loading|no collection links are rendered/i.test(
            result.error || "",
          )
        ) {
          await this.service.sleep(800);
          continue;
        }
        throw new Error(
          result.error || "The service could not discover sources.",
        );
      }
      if (result.navigate) {
        const target = new URL(result.navigate);
        if (
          target.origin !== "https://www.instagram.com" ||
          !/^\/[^/]+\/saved\/?$/.test(target.pathname)
        )
          throw new Error("Unexpected discovery navigation.");
        if (this.owned.has(tab.id))
          await this.browser.tabs.update(tab.id, { url: target.href });
        else {
          tab = await this.open(target.href);
          this.serviceTabs.set(service, tab.id);
        }
      }
      if (!result.pending) break;
      await this.service.sleep(800);
    }
    if (result.pending)
      throw new Error("The service is still loading. Retry discover_sources.");
    const candidates = result.candidates.map((candidate) => {
      const candidateId = crypto.randomUUID();
      this.candidates.set(candidateId, {
        ...candidate,
        service,
        tabId: tab.id,
      });
      return {
        candidateId,
        id: candidate.id,
        name: candidate.name,
        count: candidate.count,
        users: candidate.users,
        service,
        url: candidate.url,
      };
    });
    return {
      candidates,
      nextCursor: result.nextCursor,
      warnings: [
        ...(result.warnings || []),
        ...(activated
          ? ["Maps required activating its existing tab to render Saved lists."]
          : []),
      ],
      tabId: tab.id,
      transport: result.transport,
    };
  }
  async prepare({ service, url, candidateId, name }) {
    await this.access(service);
    let candidate = candidateId && this.candidates.get(candidateId);
    if (candidateId && (!candidate || candidate.service !== service))
      throw new Error(
        "Candidate expired or belongs to another service. Discover sources again.",
      );
    if (!candidate && name) {
      let found = await this.discover({ service });
      const seen = new Set();
      while (found.nextCursor && !seen.has(found.nextCursor)) {
        seen.add(found.nextCursor);
        if (seen.size > 100)
          throw new Error("Source discovery exceeded its pagination limit.");
        const page = await this.discover({ service, cursor: found.nextCursor });
        found = {
          ...page,
          candidates: [...found.candidates, ...page.candidates],
          warnings: [
            ...new Set([...(found.warnings || []), ...(page.warnings || [])]),
          ],
        };
      }
      if (found.nextCursor)
        throw new Error("Source discovery repeated its pagination cursor.");
      const query = name.replace(/^@/, "").toLocaleLowerCase();
      const matches = found.candidates.filter((item) =>
        [item.name, ...(item.users || [])].some(
          (value) => value.toLocaleLowerCase() === query,
        ),
      );
      if (matches.length !== 1)
        return {
          needsSelection: true,
          ...found,
          reason: matches.length
            ? "Several sources match. Choose a candidate."
            : "No exact match on this page. Use candidates or paginate discovery.",
        };
      candidate = this.candidates.get(matches[0].candidateId);
    }
    if (candidate?.select) {
      const result = await this.service.execute(
        candidate.tabId,
        discoverRequest,
        {
          service,
          select: candidate.select,
        },
      );
      url = result.url;
      if (result.pending) {
        for (let attempt = 0; attempt < 30; attempt++) {
          const current = await this.browser.tabs.get(candidate.tabId);
          if (/placelists\/list\/|!11m/.test(new URL(current.url).pathname)) {
            url = current.url;
            break;
          }
          await this.service.sleep(200);
        }
        if (!url)
          throw new Error(
            "The selected Maps list did not open. Retry discovery.",
          );
      }
    } else if (candidate) url = candidate.url;
    if (url && (name || candidateId) && !candidate)
      throw new Error("Choose one target: URL, candidateId, or name.");
    if (!url)
      return { needsSelection: true, ...(await this.discover({ service })) };
    const parsed = new URL(url);
    if (parsed.username || parsed.password || sourceForUrl(url)?.id !== service)
      throw new Error(
        "URL does not match the supported service and source type.",
      );
    if (service === "instagram-saved" && this.service.instagram) {
      const collectionId = parsed.pathname.match(
        /\/saved\/(?:[^/]+\/)?(\d+)\/?$/,
      )?.[1];
      if (!collectionId)
        throw new Error("Choose a named Instagram saved collection.");
      const tab = candidate
        ? await this.browser.tabs.get(candidate.tabId)
        : (await this.findTab(service)) || (await this.open(home[service]));
      const sourceId = crypto.randomUUID();
      this.service.sources.set(sourceId, {
        sourceId,
        tabId: tab.id,
        url: tab.url,
        title: candidate?.name,
        adapter: {
          id: "instagram-saved",
          operation: "saved_posts",
          itemType: "post",
        },
        apiTarget: { collectionId, expectedCount: candidate?.count },
        inUse: true,
        managed: this.owned.has(tab.id),
      });
      return this.service.describe(sourceId);
    }
    const tab =
      service === "whatsapp" && candidate
        ? await this.browser.tabs.get(candidate.tabId)
        : (await this.findTab(service, url)) || (await this.open(url));
    if (sourceForUrl(tab.url)?.id !== service)
      throw new Error(
        `The service redirected, possibly to login. Complete login in tab ${tab.id}, then retry.`,
      );
    const sourceId = crypto.randomUUID();
    this.service.sources.set(sourceId, {
      sourceId,
      tabId: tab.id,
      url: tab.url,
      title: candidate?.name || tab.title,
      adapter: sourceForUrl(tab.url),
      inUse: true,
      targetId: service === "whatsapp" ? candidate?.id : undefined,
      managed: this.owned.has(tab.id),
    });
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        const current = await this.browser.tabs.get(tab.id);
        const source = this.service.sources.get(sourceId);
        if (sourceForUrl(current.url)?.id !== service)
          throw new Error(
            "The service redirected outside the selected source.",
          );
        source.url = current.url;
        source.stale = false;
        try {
          return await this.service.describe(sourceId);
        } catch (error) {
          if (
            attempt === 9 ||
            !/with its places visible|still loading/i.test(error.message)
          )
            throw error;
          await this.service.sleep(500);
        }
      }
    } catch (error) {
      throw new Error(
        `${error.message} Background tab ${tab.id} is available if login is needed.`,
      );
    }
  }
  async release(sourceId) {
    const source = this.service.sources.get(sourceId);
    if (!source) throw new Error("Source not found.");
    if (
      [...this.service.jobs.values()].some(
        (job) => job.source.tabId === source.tabId && job.state === "running",
      )
    )
      throw new Error("Wait for or cancel the job before closing its source.");
    this.service.sources.delete(sourceId);
    const referenced = [...this.service.sources.values()].some(
      (other) => other.tabId === source.tabId,
    );
    if (!referenced && this.owned.delete(source.tabId)) {
      await this.browser.tabs.remove(source.tabId);
      for (const [key, id] of this.serviceTabs)
        if (id === source.tabId) this.serviceTabs.delete(key);
    }
    return { released: true };
  }
}
