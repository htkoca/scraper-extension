import { platformForUrl } from "./platforms.js";

export function sourceForUrl(value) {
  const platform = platformForUrl(value);
  if (platform)
    return {
      id: platform.id,
      operation:
        platform.id === "instagram-saved" ? "saved_posts" : "conversation",
      itemType: platform.id === "instagram-saved" ? "post" : "message",
    };
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      ((url.hostname === "www.google.com" &&
        url.pathname.startsWith("/maps")) ||
        url.hostname === "maps.google.com")
    )
      return {
        id: "google-maps",
        operation: "saved_places",
        itemType: "place",
      };
  } catch {
    /* Unsupported URL. */
  }
  return null;
}

export const siteOrigins = {
  instagram: ["https://www.instagram.com/*"],
  whatsapp: ["https://web.whatsapp.com/*"],
  "google-maps": ["https://www.google.com/maps/*", "https://maps.google.com/*"],
};
