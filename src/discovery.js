// Read-only discovery inside the signed-in service page. Never sends a message.
export async function discoverRequest({ service, cursor, select }) {
  try {
    if (service === "whatsapp") {
      if (location.origin !== "https://web.whatsapp.com")
        throw new Error("Unexpected service origin.");
      const store = window.require?.("WAWebCollections");
      if (!store?.Chat?.getModelsArray)
        throw new Error("WhatsApp is still loading or needs QR login.");
      const chats = store.Chat.getModelsArray();
      if (!chats.length) return { ok: true, pending: true, candidates: [] };
      return {
        ok: true,
        candidates: chats
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
      if (!response.ok) {
        if (saved && response.status === 404) {
          const links = [...document.querySelectorAll("a[href]")];
          const collections = links
            .map((link) => {
              const url = new URL(link.href, location.origin);
              const match = /^\/[^/]+\/saved\/(?:[^/]+\/)?(\d+)\/?$/.exec(
                url.pathname,
              );
              return match && url.origin === location.origin
                ? {
                    id: match[1],
                    url: url.href,
                    name: (
                      link.getAttribute("aria-label") || link.textContent
                    ).trim(),
                  }
                : null;
            })
            .filter((item) => item && item.name);
          if (collections.length)
            return {
              ok: true,
              candidates: [
                ...new Map(collections.map((item) => [item.id, item])).values(),
              ],
              nextCursor: null,
              warnings: [
                "Instagram collection API is unavailable. Only collections rendered on the Saved page were discovered; coverage is unverified.",
              ],
            };
          const savedLink = links.find((link) => {
            const url = new URL(link.href, location.origin);
            return !url.hash && /^\/[^/]+\/saved\/?$/.test(url.pathname);
          });
          const profileLink = links.find((link) => {
            const path = new URL(link.href, location.origin).pathname;
            return (
              !new URL(link.href, location.origin).hash &&
              /^\/[A-Za-z0-9._]+\/$/.test(path) &&
              /profile/i.test(
                (link.getAttribute("aria-label") || "") + link.textContent,
              )
            );
          });
          const target =
            savedLink?.href ||
            (profileLink && new URL("saved/", profileLink.href).href);
          if (
            target &&
            new URL(target).origin === location.origin &&
            new URL(target).pathname !== location.pathname
          )
            return {
              ok: true,
              navigate: target,
              pending: true,
              candidates: [],
            };
          throw new Error(
            "Instagram collection API returned HTTP 404 and no collection links are rendered. Open your profile's Saved page and retry.",
          );
        }
        throw new Error(
          `Instagram discovery returned HTTP ${response.status}.`,
        );
      }
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
      const label = (el) => {
        if (el.getAttribute("aria-label"))
          return el.getAttribute("aria-label").trim();
        const copy = el.cloneNode(true);
        copy
          .querySelectorAll(
            '[aria-hidden="true"],svg,.google-symbols,.material-icons',
          )
          .forEach((node) => node.remove());
        return copy.textContent.replace(/\s+/g, " ").trim();
      };
      const buttons = [...document.querySelectorAll('button,[role="button"]')];
      if (select) {
        const matches = buttons.filter((button) => label(button) === select);
        if (matches.length !== 1)
          throw new Error(
            "The saved list selection changed or is ambiguous. Discover sources again.",
          );
        const before = location.href;
        if (typeof MouseEvent !== "undefined")
          matches[0].dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: window,
              button: 0,
              detail: 1,
            }),
          );
        else matches[0].click();
        return {
          ok: true,
          pending: location.href === before,
          url: location.href !== before ? location.href : undefined,
        };
      }
      const candidates = [...document.querySelectorAll("a[href]")]
        .filter((link) => {
          const target = new URL(link.href, location.href);
          return (
            target.origin === location.origin &&
            target.pathname.startsWith("/maps") &&
            /placelists\/list\/|!11m/.test(target.pathname)
          );
        })
        .map((link) => ({ id: link.href, url: link.href, name: label(link) }))
        .filter((item) => item.name);
      for (const button of buttons) {
        const text = label(button);
        const title = button
          .querySelector(".fontBodyLarge")
          ?.textContent.trim();
        const metadata = button
          .querySelector(".fontBodyMedium")
          ?.textContent.trim();
        const match =
          /^(.*?)\s*(?:Private|Shared)\s*[·•]\s*[\d,]+\s*places?$/i.exec(text);
        const card =
          title &&
          /^(?:Private|Shared)\s*[·•]\s*[\d,]+\s*places?$/i.test(
            metadata || "",
          );
        if (match || card)
          candidates.push({
            id: text,
            name: card ? title : match[1],
            url: location.href,
            select: text,
          });
      }
      if (candidates.length)
        return {
          ok: true,
          candidates: [
            ...new Map(candidates.map((item) => [item.id, item])).values(),
          ],
          nextCursor: null,
        };
      const saved =
        document.querySelector('button[jsaction="navigationrail.saved"]') ||
        buttons.find((el) => /^(Saved|Your places)$/i.test(label(el)));
      if (saved) {
        saved.click();
        return { ok: true, pending: true, candidates: [] };
      }
      throw new Error(
        "Maps did not expose saved-list links or buttons. Supply the saved list URL, or open Saved in Maps once.",
      );
    }
    throw new Error("Unsupported service.");
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
