import { discoverRequest } from "./discovery.js";
import { siteOrigins, sourceForUrl } from "./sources.js";

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
  async discover({ service, cursor }) {
    await this.access(service);
    let tab;
    const existing = this.serviceTabs.get(service);
    if (existing) tab = await this.browser.tabs.get(existing).catch(() => null);
    if (!tab) {
      tab = await this.open(home[service]);
      this.serviceTabs.set(service, tab.id);
    }
    let result;
    for (let i = 0; i < 3; i++) {
      result = await this.service.execute(tab.id, discoverRequest, {
        service,
        cursor,
      });
      if (!result.pending) break;
      await this.service.sleep(800);
    }
    if (result.pending)
      throw new Error("Maps Saved is still loading. Retry discover_sources.");
    const candidates = result.candidates.map((candidate) => {
      const candidateId = crypto.randomUUID();
      this.candidates.set(candidateId, {
        ...candidate,
        service,
        tabId: tab.id,
      });
      return {
        candidateId,
        name: candidate.name,
        users: candidate.users,
        service,
        url: candidate.url,
      };
    });
    return {
      candidates,
      nextCursor: result.nextCursor,
      warnings: result.warnings || [],
      tabId: tab.id,
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
      const found = await this.discover({ service });
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
    if (candidate) url = candidate.url;
    if (url && (name || candidateId) && !candidate)
      throw new Error("Choose one target: URL, candidateId, or name.");
    if (!url)
      return { needsSelection: true, ...(await this.discover({ service })) };
    const parsed = new URL(url);
    if (parsed.username || parsed.password || sourceForUrl(url)?.id !== service)
      throw new Error(
        "URL does not match the supported service and source type.",
      );
    const tab =
      service === "whatsapp" && candidate
        ? await this.browser.tabs.get(candidate.tabId)
        : await this.open(url);
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
      return await this.service.describe(sourceId);
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
    if (this.owned.delete(source.tabId)) {
      await this.browser.tabs.remove(source.tabId);
      for (const [key, id] of this.serviceTabs)
        if (id === source.tabId) this.serviceTabs.delete(key);
    }
    return { released: true };
  }
}
