import {
  instagramRequest,
  DEFAULT_QUERY_ID,
  TRANSCRIPTION_QUERY_ID,
} from "./instagram.js";
import { normalizeMessage } from "./instagram-model.js";
import { whatsappRequest } from "./whatsapp.js";

// Page functions must be self-contained: Chrome serializes them into MAIN.
export const platforms = {
  instagram: {
    id: "instagram",
    label: "Instagram",
    request: instagramRequest,
    matches: (url) =>
      url.origin === "https://www.instagram.com" &&
      /^\/direct\/t\/\d+\/?$/.test(url.pathname),
    capabilities: { media: true, transcribe: true, queryId: true },
    messageRequest: (options) => ({
      queryId: options.queryId || DEFAULT_QUERY_ID,
    }),
    transcriptionRequest: () => ({ queryId: TRANSCRIPTION_QUERY_ID }),
    page: (result) => ({
      messages: result.connection?.edges
        ?.filter((e) => e.node)
        .map((e) => normalizeMessage(e.node, result.viewerId)),
      hasMore: result.connection?.page_info?.has_next_page,
      nextCursor: result.connection?.page_info?.end_cursor,
    }),
  },
  whatsapp: {
    id: "whatsapp",
    label: "WhatsApp",
    request: whatsappRequest,
    matches: (url) =>
      url.origin === "https://web.whatsapp.com" && url.pathname === "/",
    capabilities: { media: false, transcribe: false, queryId: false },
    messageRequest: () => ({}),
    page: (result) => result.page,
  },
};
export function platformForUrl(value) {
  try {
    const url = new URL(value);
    return Object.values(platforms).find((p) => p.matches(url)) || null;
  } catch {
    return null;
  }
}
export function getPlatform(id = "instagram") {
  const platform = Object.hasOwn(platforms, id) && platforms[id];
  if (!platform) throw new Error("Unsupported conversation platform.");
  return platform;
}
