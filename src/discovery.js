// Read-only discovery inside the signed-in service page. Never sends a message.
export async function discoverRequest({ service, cursor }) {
  try {
    if (service === "whatsapp") {
      if (location.origin !== "https://web.whatsapp.com")
        throw new Error("Unexpected service origin.");
      const store = window.require?.("WAWebCollections");
      if (!store?.Chat?.getModelsArray)
        throw new Error("WhatsApp is still loading or needs QR login.");
      return {
        ok: true,
        candidates: store.Chat.getModelsArray()
          .map((chat) => ({
            id: chat.id?._serialized,
            name: chat.formattedTitle || chat.name || chat.id?._serialized,
            url: "https://web.whatsapp.com/",
          }))
          .filter((chat) => chat.id),
        nextCursor: null,
        warnings: ["Only chats loaded by the linked browser are available."],
      };
    }
    if (service === "instagram-saved" || service === "instagram") {
      if (location.origin !== "https://www.instagram.com")
        throw new Error("Unexpected service origin.");
      const csrf = document.cookie
        .split(/;\s*/)
        .find((value) => value.startsWith("csrftoken="))
        ?.slice(10);
      if (!csrf || !document.cookie.includes("ds_user_id="))
        throw new Error("Sign in to Instagram in the opened browser tab.");
      const saved = service === "instagram-saved";
      const params = new URLSearchParams(
        saved ? { collection_types: '["MEDIA"]' } : { limit: "50" },
      );
      if (cursor) params.set(saved ? "max_id" : "cursor", cursor);
      const response = await fetch(
        (saved ? "/api/v1/collections/list/" : "/api/v1/direct_v2/inbox/") +
          "?" +
          params,
        {
          credentials: "include",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: { "X-CSRFToken": csrf, "X-IG-App-ID": "936619743392459" },
        },
      );
      if (!response.ok)
        throw new Error(
          `Instagram discovery returned HTTP ${response.status}.`,
        );
      const body = await response.json();
      const items = saved ? body.items : body.inbox?.threads;
      if (body.status !== "ok" || !Array.isArray(items))
        throw new Error(
          "Instagram discovery response changed or requires login.",
        );
      let username;
      if (saved) {
        const accountResponse = await fetch(
          "/api/v1/accounts/current_user/?edit=true",
          {
            credentials: "include",
            redirect: "error",
            signal: AbortSignal.timeout(15000),
            headers: { "X-CSRFToken": csrf, "X-IG-App-ID": "936619743392459" },
          },
        );
        if (!accountResponse.ok)
          throw new Error(
            "Could not resolve the signed-in Instagram profile. Use a saved collection URL.",
          );
        username = (await accountResponse.json()).user?.username;
        if (!/^[A-Za-z0-9._]+$/.test(username || ""))
          throw new Error("Instagram did not return a profile username.");
      }
      const candidates = items.map((item) =>
        saved
          ? {
              id: String(item.collection_id),
              name: item.collection_name,
              url: `https://www.instagram.com/${username}/saved/collection/${item.collection_id}/`,
            }
          : {
              id: String(item.thread_id),
              name:
                item.thread_title ||
                item.users?.map((user) => user.username).join(", "),
              users: item.users?.map((user) => user.username) || [],
              url: `https://www.instagram.com/direct/t/${item.thread_id}/`,
            },
      );
      if (candidates.some((item) => !/^\d+$/.test(item.id) || !item.name))
        throw new Error("Instagram returned an incomplete source identity.");
      const more = saved ? body.more_available : body.inbox.has_older;
      const nextCursor = more
        ? saved
          ? body.next_max_id || body.max_id
          : body.inbox.oldest_cursor
        : null;
      if (more && (!nextCursor || nextCursor === cursor))
        throw new Error("Instagram discovery did not advance its cursor.");
      return { ok: true, candidates, nextCursor: nextCursor || null };
    }
    if (service === "google-maps") {
      if (
        location.hostname !== "www.google.com" ||
        !location.pathname.startsWith("/maps")
      )
        throw new Error("Unexpected Maps origin.");
      if (/accounts\.google\.com/.test(location.href))
        throw new Error("Sign in to Google Maps.");
      const candidates = [...document.querySelectorAll("a[href]")]
        .filter((link) => /placelists\/list\/|!11m/.test(link.href))
        .map((link) => ({
          id: link.href,
          url: link.href,
          name: link.getAttribute("aria-label") || link.textContent.trim(),
        }))
        .filter((item) => item.name);
      if (candidates.length)
        return {
          ok: true,
          candidates: [
            ...new Map(candidates.map((item) => [item.url, item])).values(),
          ],
          nextCursor: null,
        };
      const saved = [
        ...document.querySelectorAll('button,[role="button"]'),
      ].find((el) =>
        /^(Saved|Your places)$/i.test(
          el.getAttribute("aria-label") || el.textContent.trim(),
        ),
      );
      if (saved) {
        saved.click();
        return { ok: true, pending: true, candidates: [] };
      }
      throw new Error(
        "Maps did not expose saved-list links. Supply the saved list URL, or open Saved in Maps once.",
      );
    }
    throw new Error("Unsupported service.");
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
