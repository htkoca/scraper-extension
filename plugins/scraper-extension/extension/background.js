// src/instagram-api.js
function instagramAccountContext() {
  try {
    if (location.origin !== "https://www.instagram.com")
      throw new Error("Open a signed-in Instagram tab first.");
    const viewerId = document.cookie.split(/;\s*/).find((c) => c.startsWith("ds_user_id="))?.slice(11);
    if (!viewerId)
      throw new Error("Sign in to Instagram in the selected browser tab.");
    const ownProfile = [...document.querySelectorAll("a[href]")].find(
      (link) => {
        const path = new URL(link.href, location.origin).pathname;
        return /^\/[A-Za-z0-9._]+\/$/.test(path) && /profile/i.test(
          (link.getAttribute("aria-label") || "") + (link.querySelector("img")?.getAttribute("alt") || "") + link.textContent
        );
      }
    );
    const username = ownProfile && new URL(ownProfile.href, location.origin).pathname.split("/")[1];
    return { ok: true, viewerId, username };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
async function instagramGraphqlRequest({
  friendly,
  fallbackId,
  variables
}) {
  try {
    if (location.origin !== "https://www.instagram.com")
      throw new Error("Open a signed-in Instagram tab first.");
    const scripts = [...document.scripts].map((s) => s.textContent || "").join("\n");
    const token = (name) => {
      try {
        const value = window.require?.(name)?.token;
        if (value) return value;
      } catch {
      }
      return scripts.match(
        new RegExp(
          '"' + name + '"\\s*,\\s*\\[\\]\\s*,\\s*\\{\\s*"token"\\s*:\\s*"([^"\\n]+)"'
        )
      )?.[1];
    };
    const cookie = (name) => document.cookie.split(/;\s*/).find((c) => c.startsWith(name + "="))?.slice(name.length + 1);
    const csrf = cookie("csrftoken"), viewerId = cookie("ds_user_id"), dtsg = token("DTSGInitialData"), lsd = token("LSD");
    if (!csrf || !viewerId || !dtsg || !lsd)
      throw new Error(
        "Instagram authentication is still loading or requires sign-in. Refresh this tab and retry."
      );
    let queryId = fallbackId;
    try {
      queryId = window.require?.(friendly + ".graphql")?.params?.id || fallbackId;
    } catch {
    }
    const response = await fetch("/api/graphql", {
      method: "POST",
      credentials: "include",
      redirect: "error",
      signal: AbortSignal.timeout(25e3),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRFToken": csrf,
        "X-FB-Friendly-Name": friendly,
        "X-FB-LSD": lsd,
        "X-IG-App-ID": "936619743392459"
      },
      body: new URLSearchParams({
        av: "0",
        __d: "www",
        __user: "0",
        __a: "1",
        __comet_req: "7",
        fb_dtsg: dtsg,
        lsd,
        fb_api_caller_class: "RelayModern",
        fb_api_req_friendly_name: friendly,
        server_timestamps: "true",
        doc_id: String(queryId),
        variables: JSON.stringify(variables)
      }).toString()
    });
    if (!response.ok)
      return {
        ok: false,
        status: response.status,
        retryAfter: response.headers.get("Retry-After"),
        error: `Instagram source-tab request returned HTTP ${response.status}.`
      };
    const body = JSON.parse(
      (await response.text()).replace(/^for \(;;\);/, "")
    );
    if (body.errors?.length)
      throw new Error(
        "Instagram GraphQL: " + body.errors.map((e) => e.message || "Unknown error").join("; ")
      );
    if (!body.data)
      throw new Error(
        `Instagram source-tab request returned no GraphQL data${typeof body.error === "number" ? " (code " + body.error + ")" : ""}.`
      );
    const ownProfile = [...document.querySelectorAll("a[href]")].find(
      (link) => {
        const path = new URL(link.href, location.origin).pathname;
        return /^\/[A-Za-z0-9._]+\/$/.test(path) && /profile/i.test(
          (link.getAttribute("aria-label") || "") + (link.querySelector("img")?.getAttribute("alt") || "") + link.textContent
        );
      }
    );
    const username = ownProfile && new URL(ownProfile.href, location.origin).pathname.split("/")[1];
    return {
      ok: true,
      data: body.data,
      viewerId,
      username,
      transport: "source-tab",
      warnings: []
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
var InstagramApi = class {
  constructor({ execute }) {
    this.execute = execute;
  }
  async graphql(tabId, friendly, fallbackId, variables) {
    return this.execute(
      tabId,
      instagramGraphqlRequest,
      { friendly, fallbackId, variables },
      true
    );
  }
  async discover(tabId, cursor) {
    const friendly = "PolarisProfileSavedTabContentQuery";
    const result = await this.graphql(tabId, friendly, "27584326974521636", {
      collection_types: [
        "ALL_MEDIA_AUTO_COLLECTION",
        "PLAYLIST_AUTO_COLLECTION",
        "MEDIA",
        "AUDIO_AUTO_COLLECTION"
      ],
      first: 12,
      ...cursor ? { after: cursor } : {}
    });
    if (!result.ok)
      throw new Error(result.error || "Instagram collection discovery failed.");
    const connection = result.data?.viewer?.collections_unified_with_auto_collections;
    if (!Array.isArray(connection?.edges) || typeof connection.page_info?.has_next_page !== "boolean")
      throw new Error(
        "Instagram Saved collection response changed (transport=" + result.transport + "; data=" + Object.keys(result.data || {}).join(",") + "; viewer=" + Object.keys(result.data?.viewer || {}).join(",") + "). No complete discovery was reported."
      );
    if (!result.username)
      throw new Error(
        "Could not identify the signed-in Instagram profile from its navigation. Open your profile once, then retry."
      );
    const nodes = connection.edges.map(({ node }) => node).filter((node) => {
      if (/^(?:IG|XDT)?(?:AllMedia|Audio|Playlist)AutoCollection$/.test(
        node?.__typename || ""
      ))
        return false;
      if (!node || !/^\d+$/.test(String(node.collection_id || node.id || "")) || typeof node.collection_name !== "string")
        throw new Error(
          "Instagram unsupported collection (type=" + node?.__typename + "; fields=" + Object.keys(node || {}).join(",") + "; transport=" + result.transport + "; " + (result.warnings || []).join(" ") + ")."
        );
      return true;
    });
    const candidates = nodes.map((node) => ({
      id: String(node.collection_id || node.id || ""),
      name: node.collection_name,
      count: node.collection_media_count,
      url: `https://www.instagram.com/${result.username}/saved/collection/${node.collection_id || node.id}/`
    })).filter((item) => /^\d+$/.test(item.id) && typeof item.name === "string");
    const nextCursor = connection.page_info.has_next_page ? connection.page_info.end_cursor : null;
    if (connection.page_info.has_next_page && (!nextCursor || nextCursor === cursor))
      throw new Error(
        "Instagram collection discovery did not advance its cursor."
      );
    return {
      ok: true,
      candidates,
      nextCursor,
      transport: result.transport,
      warnings: result.warnings
    };
  }
  async context(tabId, collectionId, title) {
    const account = await this.execute(tabId, instagramAccountContext, {});
    return {
      ok: true,
      threadId: collectionId ? `saved-${account.viewerId}-${collectionId}` : `saved-${account.viewerId}`,
      title: title || `Saved collection ${collectionId}`,
      collectionId,
      warnings: [
        "Captions and post links only. Publication dates unavailable in the saved collection API are left unknown. Media downloads are not included."
      ]
    };
  }
  async posts(tabId, collectionId, cursor, expectedIdentity) {
    if (!/^\d+$/.test(collectionId || ""))
      throw new Error(
        "Choose a named saved collection; All posts is not supported by this query."
      );
    const result = await this.graphql(
      tabId,
      "PolarisSavedCollectionPageWWWQuery",
      "39910535158594768",
      {
        after: cursor || null,
        collection_id: collectionId,
        first: 12,
        __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true,
        __relay_internal__pv__PolarisSEOIsCrawlerrelayprovider: false
      }
    );
    if (!result.ok) return result;
    if (expectedIdentity && expectedIdentity !== `saved-${result.viewerId}-${collectionId}`)
      throw new Error(
        "The Instagram account changed during collection. Prepare the source again."
      );
    const collection = result.data?.fetch__MediaCollection;
    const connection = collection?.media;
    if (!Array.isArray(connection?.edges) || typeof connection.page_info?.has_next_page !== "boolean" || String(collection.id) !== collectionId)
      throw new Error(
        "Instagram saved collection contents response changed or selected another collection."
      );
    const messages = connection.edges.map(({ node: post }) => {
      if (!post || !/^\d+$/.test(String(post.pk || "")) || !/^[A-Za-z0-9_-]+$/.test(post.code || "") || post.caption != null && typeof post.caption.text !== "string")
        throw new Error("Instagram returned unsupported saved-post metadata.");
      const caption = post.caption?.text || "";
      return {
        id: String(post.pk),
        timestamp: Number.isFinite(post.taken_at) ? post.taken_at * 1e3 : null,
        sender: post.user?.username || "Unknown author",
        senderId: String(post.user?.pk || ""),
        isMe: false,
        text: caption,
        caption,
        url: `https://www.instagram.com/p/${post.code}/`,
        type: "saved-post",
        attachments: [],
        reactions: [],
        raw: { code: post.code, media_type: post.media_type }
      };
    });
    const info = connection.page_info;
    if (info.has_next_page && (!info.end_cursor || info.end_cursor === cursor))
      throw new Error(
        "Instagram saved-post pagination did not advance its cursor."
      );
    return {
      ok: true,
      page: {
        messages,
        hasMore: info.has_next_page,
        nextCursor: info.end_cursor || null
      },
      title: collection.name,
      transport: result.transport,
      warnings: result.warnings
    };
  }
};

// src/discovery.js
async function discoverRequest({ service, cursor, select }) {
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
        candidates: chats.map((chat) => ({
          id: chat.id?._serialized,
          name: chat.formattedTitle || chat.name || chat.id?._serialized,
          url: "https://web.whatsapp.com/"
        })).filter((chat) => chat.id),
        nextCursor: null,
        warnings: ["Only chats loaded by the linked browser are available."]
      };
    }
    if (service === "instagram-saved" || service === "instagram") {
      if (location.origin !== "https://www.instagram.com")
        throw new Error("Unexpected service origin.");
      const csrf = document.cookie.split(/;\s*/).find((value) => value.startsWith("csrftoken="))?.slice(10);
      if (!csrf || !document.cookie.includes("ds_user_id="))
        throw new Error("Sign in to Instagram in the opened browser tab.");
      const saved = service === "instagram-saved";
      const params = new URLSearchParams(
        saved ? { collection_types: '["MEDIA"]' } : { limit: "50" }
      );
      if (cursor) params.set(saved ? "max_id" : "cursor", cursor);
      const response = await fetch(
        (saved ? "/api/v1/collections/list/" : "/api/v1/direct_v2/inbox/") + "?" + params,
        {
          credentials: "include",
          redirect: "error",
          signal: AbortSignal.timeout(15e3),
          headers: { "X-CSRFToken": csrf, "X-IG-App-ID": "936619743392459" }
        }
      );
      if (!response.ok) {
        if (saved && response.status === 404) {
          const links = [...document.querySelectorAll("a[href]")];
          const collections = links.map((link) => {
            const url = new URL(link.href, location.origin);
            const match = /^\/[^/]+\/saved\/(?:[^/]+\/)?(\d+)\/?$/.exec(
              url.pathname
            );
            return match && url.origin === location.origin ? {
              id: match[1],
              url: url.href,
              name: (link.getAttribute("aria-label") || link.textContent).trim()
            } : null;
          }).filter((item) => item && item.name);
          if (collections.length)
            return {
              ok: true,
              candidates: [
                ...new Map(collections.map((item) => [item.id, item])).values()
              ],
              nextCursor: null,
              warnings: [
                "Instagram collection API is unavailable. Only collections rendered on the Saved page were discovered; coverage is unverified."
              ]
            };
          const savedLink = links.find((link) => {
            const url = new URL(link.href, location.origin);
            return !url.hash && /^\/[^/]+\/saved\/?$/.test(url.pathname);
          });
          const profileLink = links.find((link) => {
            const path = new URL(link.href, location.origin).pathname;
            return !new URL(link.href, location.origin).hash && /^\/[A-Za-z0-9._]+\/$/.test(path) && /profile/i.test(
              (link.getAttribute("aria-label") || "") + link.textContent
            );
          });
          const target = savedLink?.href || profileLink && new URL("saved/", profileLink.href).href;
          if (target && new URL(target).origin === location.origin && new URL(target).pathname !== location.pathname)
            return {
              ok: true,
              navigate: target,
              pending: true,
              candidates: []
            };
          throw new Error(
            "Instagram collection API returned HTTP 404 and no collection links are rendered. Open your profile's Saved page and retry."
          );
        }
        throw new Error(
          `Instagram discovery returned HTTP ${response.status}.`
        );
      }
      const body = await response.json();
      const items = saved ? body.items : body.inbox?.threads;
      if (body.status !== "ok" || !Array.isArray(items))
        throw new Error(
          "Instagram discovery response changed or requires login."
        );
      let username;
      if (saved) {
        const accountResponse = await fetch(
          "/api/v1/accounts/current_user/?edit=true",
          {
            credentials: "include",
            redirect: "error",
            signal: AbortSignal.timeout(15e3),
            headers: { "X-CSRFToken": csrf, "X-IG-App-ID": "936619743392459" }
          }
        );
        if (!accountResponse.ok)
          throw new Error(
            "Could not resolve the signed-in Instagram profile. Use a saved collection URL."
          );
        username = (await accountResponse.json()).user?.username;
        if (!/^[A-Za-z0-9._]+$/.test(username || ""))
          throw new Error("Instagram did not return a profile username.");
      }
      const candidates = items.map(
        (item) => saved ? {
          id: String(item.collection_id),
          name: item.collection_name,
          url: `https://www.instagram.com/${username}/saved/collection/${item.collection_id}/`
        } : {
          id: String(item.thread_id),
          name: item.thread_title || item.users?.map((user) => user.username).join(", "),
          users: item.users?.map((user) => user.username) || [],
          url: `https://www.instagram.com/direct/t/${item.thread_id}/`
        }
      );
      if (candidates.some((item) => !/^\d+$/.test(item.id) || !item.name))
        throw new Error("Instagram returned an incomplete source identity.");
      const more = saved ? body.more_available : body.inbox.has_older;
      const nextCursor = more ? saved ? body.next_max_id || body.max_id : body.inbox.oldest_cursor : null;
      if (more && (!nextCursor || nextCursor === cursor))
        throw new Error("Instagram discovery did not advance its cursor.");
      return { ok: true, candidates, nextCursor: nextCursor || null };
    }
    if (service === "google-maps") {
      if (location.hostname !== "www.google.com" || !location.pathname.startsWith("/maps"))
        throw new Error("Unexpected Maps origin.");
      if (/accounts\.google\.com/.test(location.href))
        throw new Error("Sign in to Google Maps.");
      const label = (el) => {
        if (el.getAttribute("aria-label"))
          return el.getAttribute("aria-label").trim();
        const copy = el.cloneNode(true);
        copy.querySelectorAll(
          '[aria-hidden="true"],svg,.google-symbols,.material-icons'
        ).forEach((node) => node.remove());
        return copy.textContent.replace(/\s+/g, " ").trim();
      };
      const buttons = [...document.querySelectorAll('button,[role="button"]')];
      if (select) {
        const matches = buttons.filter((button) => label(button) === select);
        if (matches.length !== 1)
          throw new Error(
            "The saved list selection changed or is ambiguous. Discover sources again."
          );
        const before = location.href;
        if (typeof MouseEvent !== "undefined")
          matches[0].dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: window,
              button: 0,
              detail: 1
            })
          );
        else matches[0].click();
        return {
          ok: true,
          pending: location.href === before,
          url: location.href !== before ? location.href : void 0
        };
      }
      const candidates = [...document.querySelectorAll("a[href]")].filter((link) => {
        const target = new URL(link.href, location.href);
        return target.origin === location.origin && target.pathname.startsWith("/maps") && /placelists\/list\/|!11m/.test(target.pathname);
      }).map((link) => ({ id: link.href, url: link.href, name: label(link) })).filter((item) => item.name);
      for (const button of buttons) {
        const text = label(button);
        const title = button.querySelector(".fontBodyLarge")?.textContent.trim();
        const metadata = button.querySelector(".fontBodyMedium")?.textContent.trim();
        const match = /^(.*?)\s*(?:Private|Shared)\s*[·•]\s*[\d,]+\s*places?$/i.exec(text);
        const card = title && /^(?:Private|Shared)\s*[·•]\s*[\d,]+\s*places?$/i.test(
          metadata || ""
        );
        if (match || card)
          candidates.push({
            id: text,
            name: card ? title : match[1],
            url: location.href,
            select: text
          });
      }
      if (candidates.length)
        return {
          ok: true,
          candidates: [
            ...new Map(candidates.map((item) => [item.id, item])).values()
          ],
          nextCursor: null
        };
      const saved = document.querySelector('button[jsaction="navigationrail.saved"]') || buttons.find((el) => /^(Saved|Your places)$/i.test(label(el)));
      if (saved) {
        saved.click();
        return { ok: true, pending: true, candidates: [] };
      }
      throw new Error(
        "Maps did not expose saved-list links or buttons. Supply the saved list URL, or open Saved in Maps once."
      );
    }
    throw new Error("Unsupported service.");
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// src/instagram-saved.js
async function instagramSavedRequest(request) {
  try {
    if (location.origin !== "https://www.instagram.com" || !/^\/[^/]+\/saved(?:\/all-posts|\/(?:[^/]+\/)?\d+)?\/?$/.test(
      location.pathname
    ))
      throw new Error("Open your Instagram Saved page (All posts) first.");
    const cookie = (name) => document.cookie.split(/;\s*/).find((c) => c.startsWith(name + "="))?.slice(name.length + 1);
    const viewerId = cookie("ds_user_id");
    const csrf = cookie("csrftoken");
    if (!viewerId || !csrf)
      throw new Error(
        "Sign in to Instagram, reload the Saved page, and try again."
      );
    const segments = location.pathname.split("/").filter(Boolean);
    const selected = segments[2];
    const pathCollection = selected && selected !== "all-posts" ? segments.at(-1) : null;
    const collectionId = request.collectionId || pathCollection;
    if (collectionId && !/^\d+$/.test(collectionId))
      throw new Error(
        "This saved collection URL has no numeric collection ID. Open the collection itself."
      );
    const threadId = collectionId ? `saved-${viewerId}-${collectionId}` : `saved-${viewerId}`;
    if (request.threadId && request.threadId !== threadId)
      throw new Error(
        "The Instagram account changed or the selected collection changed. Return to the original source to resume."
      );
    if (request.kind === "context")
      return {
        ok: true,
        threadId,
        title: collectionId ? `Saved collection ${collectionId}` : "Saved posts",
        collectionId: collectionId || null,
        warnings: [
          "Captions and post links only. Unavailable publication dates are left unknown. Posts without captions are retained."
        ]
      };
    const graphql = async (friendly, fallbackId, variables) => {
      const scripts = Array.from(
        document.scripts || [],
        (script) => script.textContent || ""
      ).join("\n");
      const token = (name) => {
        try {
          const value = window.require?.(name)?.token;
          if (value) return value;
        } catch {
        }
        return scripts.match(
          new RegExp(
            '"' + name + '"\\s*,\\s*\\[\\]\\s*,\\s*\\{\\s*"token"\\s*:\\s*"([^"\\n]+)"'
          )
        )?.[1];
      };
      const dtsg = token("DTSGInitialData"), lsd = token("LSD");
      if (!dtsg || !lsd)
        throw new Error(
          "Instagram authentication is still loading. Refresh the selected tab and retry."
        );
      let queryId = fallbackId;
      try {
        queryId = window.require?.(friendly + ".graphql")?.params?.id || fallbackId;
      } catch {
      }
      const response = await fetch("/api/graphql", {
        method: "POST",
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.timeout(25e3),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-CSRFToken": csrf,
          "X-FB-Friendly-Name": friendly,
          "X-FB-LSD": lsd,
          "X-IG-App-ID": "936619743392459"
        },
        body: new URLSearchParams({
          av: "0",
          __d: "www",
          __user: "0",
          __a: "1",
          __comet_req: "7",
          fb_dtsg: dtsg,
          lsd,
          fb_api_caller_class: "RelayModern",
          fb_api_req_friendly_name: friendly,
          server_timestamps: "true",
          doc_id: String(queryId),
          variables: JSON.stringify(variables)
        }).toString()
      });
      if (!response.ok)
        return {
          ok: false,
          status: response.status,
          retryAfter: response.headers.get("Retry-After"),
          error: `Instagram source-tab request returned HTTP ${response.status}.`
        };
      const body2 = await response.json();
      if (body2.errors?.length || !body2.data)
        throw new Error(
          "Instagram did not return the requested saved collection data."
        );
      return { ok: true, data: body2.data };
    };
    if (request.kind === "collections") {
      const result = await graphql(
        "PolarisProfileSavedTabContentQuery",
        "27584326974521636",
        {
          collection_types: [
            "ALL_MEDIA_AUTO_COLLECTION",
            "PLAYLIST_AUTO_COLLECTION",
            "MEDIA",
            "AUDIO_AUTO_COLLECTION"
          ],
          first: 12,
          ...request.cursor ? { after: request.cursor } : {}
        }
      );
      if (!result.ok) return result;
      const connection = result.data.viewer?.collections_unified_with_auto_collections;
      if (!Array.isArray(connection?.edges) || typeof connection.page_info?.has_next_page !== "boolean")
        throw new Error("Instagram returned an unsupported collection list.");
      const collections = connection.edges.map(({ node }) => node).filter(
        (node) => !/^(?:IG|XDT)?(?:AllMedia|Audio|Playlist)AutoCollection$/.test(
          node?.__typename || ""
        )
      ).map((node) => {
        if (!node || !/^\d+$/.test(String(node.collection_id || node.id || "")) || typeof node.collection_name !== "string")
          throw new Error("A collection is missing its name or numeric ID.");
        return {
          id: String(node.collection_id || node.id),
          name: node.collection_name,
          count: Number.isSafeInteger(node.collection_media_count) ? node.collection_media_count : null
        };
      });
      const nextCursor = connection.page_info.has_next_page ? connection.page_info.end_cursor : null;
      if (connection.page_info.has_next_page && (!nextCursor || nextCursor === request.cursor))
        throw new Error("Instagram repeated a collection cursor.");
      return { ok: true, collections, nextCursor, transport: "source-tab" };
    }
    if (request.kind !== "messages")
      throw new Error("Unsupported saved-post request.");
    const params = new URLSearchParams({
      count: "30",
      include_igtv_preview: "false"
    });
    if (request.cursor) params.set("max_id", request.cursor);
    const endpoint = collectionId ? `/api/v1/feed/collection/${collectionId}/` : "/api/v1/feed/saved/posts/";
    let body;
    if (collectionId) {
      const result = await graphql(
        "PolarisSavedCollectionPageWWWQuery",
        "39910535158594768",
        {
          after: request.cursor || null,
          collection_id: collectionId,
          first: 12,
          __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true,
          __relay_internal__pv__PolarisSEOIsCrawlerrelayprovider: false
        }
      );
      if (!result.ok) return result;
      const collection = result.data.fetch__MediaCollection, media = collection?.media;
      if (String(collection?.id) !== collectionId || !Array.isArray(media?.edges) || typeof media.page_info?.has_next_page !== "boolean")
        throw new Error("Instagram saved collection contents changed.");
      body = {
        status: "ok",
        items: media.edges.map(({ node }) => node),
        more_available: media.page_info.has_next_page,
        next_max_id: media.page_info.end_cursor
      };
    } else {
      const response = await fetch(endpoint + "?" + params, {
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.timeout(25e3),
        headers: { "X-CSRFToken": csrf, "X-IG-App-ID": "936619743392459" }
      });
      if (!response.ok)
        return {
          ok: false,
          status: response.status,
          retryAfter: response.headers.get("Retry-After"),
          error: `Instagram returned HTTP ${response.status} while loading saved posts.`
        };
      try {
        body = await response.json();
      } catch {
        throw new Error(
          "Instagram returned a non-JSON response. Check your login or account prompts."
        );
      }
    }
    if (body.status !== "ok" || !Array.isArray(body.items) || typeof body.more_available !== "boolean")
      throw new Error(
        "Instagram did not return a supported saved-post page. Reload Instagram and try again."
      );
    const messages = body.items.map((item) => {
      const post = item.media || item;
      const id = String(post.pk || post.id || "");
      if (!id || !/^[A-Za-z0-9_-]+$/.test(post.code || "") || !(collectionId && post.taken_at === void 0) && (!Number.isFinite(post.taken_at) || post.taken_at < 0) || post.caption != null && typeof post.caption.text !== "string")
        throw new Error(
          "A saved post has unsupported caption or metadata fields. Collection paused."
        );
      const caption = post.caption?.text || "";
      const url = `https://www.instagram.com/p/${post.code}/`;
      const author = post.user?.username || "Unknown author";
      return {
        id,
        timestamp: Number.isFinite(post.taken_at) ? post.taken_at * 1e3 : null,
        sender: author,
        senderId: String(post.user?.pk || ""),
        isMe: false,
        text: caption,
        caption,
        url,
        type: "saved-post",
        attachments: [],
        reactions: [],
        raw: {
          id,
          code: post.code,
          author,
          caption,
          taken_at: post.taken_at,
          media_type: post.media_type
        }
      };
    });
    return {
      ok: true,
      page: {
        messages,
        hasMore: body.more_available,
        nextCursor: body.next_max_id || null
      }
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

// src/instagram.js
var DEFAULT_QUERY_ID = "27048827731415519";
var TRANSCRIPTION_QUERY_ID = "35263279109985185";
async function instagramRequest(request) {
  try {
    if (location.origin !== "https://www.instagram.com")
      throw new Error("Open a conversation on www.instagram.com first.");
    const threadId = location.pathname.match(/^\/direct\/t\/(\d+)\/?$/)?.[1];
    if (!threadId) throw new Error("Open an Instagram conversation first.");
    if (request.threadId && request.threadId !== threadId)
      throw new Error(
        "The Instagram tab changed conversations. Return to the original conversation to resume."
      );
    if (request.kind === "context")
      return { ok: true, threadId, title: document.title };
    const scripts = Array.from(
      document.scripts,
      (s) => s.textContent || ""
    ).join("\n");
    const token = (name) => {
      const match = scripts.match(
        new RegExp(
          '"' + name + '"\\s*,\\s*\\[\\]\\s*,\\s*\\{\\s*"token"\\s*:\\s*"([^"\\n]+)"'
        )
      );
      if (match) return match[1];
      try {
        return window.require?.(name)?.token;
      } catch {
        return void 0;
      }
    };
    const dtsg = token("DTSGInitialData"), lsd = token("LSD");
    const cookie = (name) => document.cookie.split("; ").find((c) => c.startsWith(name + "="))?.slice(name.length + 1);
    const csrf = cookie("csrftoken");
    if (!dtsg || !lsd || !csrf)
      throw new Error(
        "Instagram authentication tokens are unavailable. Reload the Instagram tab and try again."
      );
    const transcription = request.kind === "transcription";
    const friendly = transcription ? "IGDAudioTranscriptionButtonOffMsysMutation" : "IGDMessageListOffMsysQuery";
    let queryId = request.queryId;
    try {
      queryId = window.require?.(friendly + ".graphql")?.params?.id || queryId;
    } catch {
    }
    const variables = transcription ? { input: { media_id: request.mediaId } } : {
      id: threadId,
      first: 20,
      after: request.cursor || null,
      before: null,
      last: null,
      __relay_internal__pv__IGDInitialMessagePageCountrelayprovider: 20
    };
    const response = await fetch("/api/graphql", {
      method: "POST",
      credentials: "include",
      signal: AbortSignal.timeout(25e3),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRFToken": csrf,
        "X-FB-Friendly-Name": friendly,
        "X-FB-LSD": lsd,
        "X-IG-App-ID": "936619743392459"
      },
      body: new URLSearchParams({
        av: "0",
        __d: "www",
        __user: "0",
        __a: "1",
        __comet_req: "7",
        fb_dtsg: dtsg,
        lsd,
        fb_api_caller_class: "RelayModern",
        fb_api_req_friendly_name: friendly,
        server_timestamps: "true",
        doc_id: String(queryId),
        variables: JSON.stringify(variables)
      }).toString()
    });
    if (!response.ok)
      return {
        ok: false,
        status: response.status,
        error: `Instagram returned HTTP ${response.status}.`,
        retryAfter: response.headers.get("Retry-After")
      };
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(
        "Instagram returned a non-JSON response. Check your login or account prompts."
      );
    }
    if (body.errors?.length)
      throw new Error(
        "Instagram API: " + body.errors.map((e) => e.message || "Unknown error").join("; ")
      );
    if (transcription) {
      const transcript = body.data?.xig_media_message_transcription?.edges?.[0]?.node;
      if (typeof transcript !== "string")
        throw new Error(
          "Instagram did not return a transcript for this voice message."
        );
      return { ok: true, transcript };
    }
    const connection = body.data?.fetch__SlideThread?.as_ig_direct_thread?.slide_messages;
    if (!Array.isArray(connection?.edges) || !connection.page_info || typeof connection.page_info.has_next_page !== "boolean") {
      throw new Error(
        "Instagram\u2019s response format changed or this thread is unsupported. No successful export was reported."
      );
    }
    return { ok: true, connection, viewerId: cookie("ds_user_id") || null };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

// src/model.js
function isMediaUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && ["cdninstagram.com", "fbcdn.net", "fbsbx.com"].some(
      (host) => u.hostname === host || u.hostname.endsWith("." + host)
    );
  } catch {
    return false;
  }
}
function createSession(options) {
  return {
    options: { ...options },
    messages: [],
    seen: /* @__PURE__ */ new Set(),
    cursors: /* @__PURE__ */ new Set(),
    cursor: null,
    pages: 0,
    complete: false,
    warnings: []
  };
}
function acceptPage(session, connection) {
  const saved = session.options.platform === "instagram-saved";
  if (saved && (session.options.start != null || session.options.end != null))
    throw new Error("Date filters are unavailable for saved posts.");
  if (!Array.isArray(connection?.messages) || typeof connection.hasMore !== "boolean")
    throw new Error("Unsupported conversation response.");
  const next = connection.nextCursor;
  const more = connection.hasMore;
  if (more && (!next || next === session.cursor || session.cursors.has(next)))
    throw new Error(
      "The platform repeated a pagination cursor. Export paused to avoid looping."
    );
  if (more && connection.messages.length === 0)
    throw new Error(
      "The platform returned an empty page with more history. Try resuming later."
    );
  const normalized = connection.messages;
  for (const message of normalized) {
    const unknownDate = saved && message.timestamp === null;
    if (!message.id || !unknownDate && (!Number.isFinite(message.timestamp) || message.timestamp < 0))
      throw new Error(
        "A message has an invalid ID or timestamp. Collection paused."
      );
  }
  let older = false, limitReached = false;
  for (const message of normalized) {
    if (session.options.start != null && message.timestamp < session.options.start) {
      older = true;
      continue;
    }
    if (session.options.end != null && message.timestamp > session.options.end)
      continue;
    if (session.seen.has(message.id)) continue;
    if (session.options.limit && session.messages.length >= session.options.limit) {
      limitReached = true;
      break;
    }
    session.seen.add(message.id);
    session.messages.push(message);
  }
  session.pages++;
  if (next) session.cursors.add(next);
  session.cursor = next || null;
  session.complete = !more || older || limitReached || Boolean(
    session.options.limit && session.messages.length >= session.options.limit
  );
}

// src/instagram-model.js
function attachmentsFrom(node) {
  const found = /* @__PURE__ */ new Map();
  const walk = (value, path = "", depth = 0, inheritedId = null) => {
    if (!value || depth > 12 || /sender|profile|avatar|reaction|user_dict/i.test(path))
      return;
    if (typeof value === "string") {
      if (!isMediaUrl(value)) return;
      const context = path + " " + value.split("?")[0];
      const type = /audio|voice|opus|m4a|aac|mp3/i.test(context) ? "audio" : /video|playable|mp4|webm/i.test(context) ? "video" : /gif|animated/i.test(context) ? "gif" : /image|photo|preview|thumbnail|jpe?g|png|webp/i.test(context) ? "image" : "other";
      const old = found.get(value);
      if (!old || old.type === "other")
        found.set(value, {
          url: value,
          type,
          mediaId: inheritedId,
          status: "not-downloaded"
        });
      return;
    }
    if (Array.isArray(value)) {
      const items = /candidates|video_versions/.test(path) ? [...value].sort((a, b) => (b.width || 0) - (a.width || 0)).slice(0, 1) : value;
      items.forEach((item) => walk(item, path, depth + 1, inheritedId));
    } else if (typeof value === "object") {
      const mediaId = value.attachment_fbid || value.media_id || inheritedId;
      for (const [key, child] of Object.entries(value))
        walk(
          child,
          path + "." + key,
          depth + 1,
          mediaId ? String(mediaId) : null
        );
    }
  };
  walk(node.content || node);
  return [...found.values()];
}
function normalizeMessage(node, viewerId) {
  const timestamp = Number(node.timestamp_ms);
  if (!Number.isFinite(timestamp) || timestamp < 0)
    throw new Error(
      "A message has an invalid timestamp. Export paused to avoid silently losing data."
    );
  const senderId = String(
    node.sender?.user_dict?.id || node.sender?.igid || node.sender_fbid || ""
  );
  const sender = node.sender?.name || node.sender?.user_dict?.username || senderId || "Unknown sender";
  const attachments = attachmentsFrom(node);
  const type = node.content?.__typename || node.__typename || "unknown";
  const text = node.text_body || node.content?.text_body || node.content?.text || (attachments.length ? `[${[...new Set(attachments.map((a) => a.type))].join(", ")} attachment]` : `[${type}]`);
  const id = String(
    node.message_id || node.item_id || node.id || `${timestamp}:${senderId}:${text}`
  );
  const reactionData = node.reactions || node.content?.reactions || [];
  return {
    id,
    timestamp,
    sender,
    senderId,
    isMe: Boolean(viewerId && senderId === String(viewerId)),
    text: String(text),
    type,
    reactions: reactionData,
    attachments,
    raw: node
  };
}

// src/whatsapp.js
async function whatsappRequest(request) {
  try {
    if (location.origin !== "https://web.whatsapp.com")
      throw new Error("Open web.whatsapp.com first.");
    if (!["context", "messages", "media"].includes(request.kind))
      throw new Error("WhatsApp does not support this request.");
    let collections;
    try {
      collections = window.require("WAWebCollections");
    } catch {
      throw new Error(
        "WhatsApp's message API is unavailable. Reload WhatsApp and try again."
      );
    }
    const id = (value) => {
      if (typeof value === "string") return value;
      if (value?._serialized) return value._serialized;
      const text = value?.toString?.();
      return text && text !== "[object Object]" ? text : "";
    };
    const chat = request.targetId ? collections.Chat.get(request.targetId) : collections.Chat.getActive?.();
    const threadId = id(chat?.id);
    if (!threadId) throw new Error("Open a WhatsApp conversation first.");
    if (request.threadId && request.threadId !== threadId)
      throw new Error(
        "The WhatsApp tab changed conversations. Return to the original conversation to resume."
      );
    if (!chat?.msgs?.getModelsArray)
      throw new Error(
        "This WhatsApp conversation is not loaded. Reopen it and try again."
      );
    if (request.kind === "context")
      return {
        ok: true,
        threadId,
        title: chat.formattedTitle || chat.name || threadId,
        warnings: [
          "WhatsApp exports history available to this linked browser. Older phone history may be unavailable. Voice notes and audio can be downloaded in a ZIP. Other media, reactions, and voice transcription are not supported."
        ]
      };
    const key = (message) => id(message.id);
    if (request.kind === "media") {
      const offset2 = request.offset ?? 0;
      if (!request.threadId || !request.messageId || !Number.isSafeInteger(offset2) || offset2 < 0)
        throw new Error(
          "Audio requires a conversation, message ID, and nonnegative byte offset."
        );
      const message = chat.msgs.getModelsArray().find((m) => key(m) === request.messageId);
      if (!message)
        throw new Error(
          "WhatsApp unloaded this message. Collect the conversation again."
        );
      if (!["ptt", "audio"].includes(message.type) || message.isViewOnce)
        throw new Error(
          "Only ordinary WhatsApp voice notes and audio are supported."
        );
      const getBlob = () => {
        let cached;
        try {
          cached = window.require("WAWebMediaInMemoryBlobCache").InMemoryMediaBlobCache.get(message.mediaObject?.filehash);
        } catch {
        }
        return cached || message.mediaObject?.mediaBlob?.forceToBlob?.();
      };
      let blob = getBlob();
      if (!blob) {
        if (!message.mediaData || typeof message.downloadMedia !== "function")
          throw new Error("WhatsApp's audio downloader is unavailable.");
        let timer;
        try {
          await Promise.race([
            message.downloadMedia({
              downloadEvenIfExpensive: true,
              rmrReason: 1,
              isUserInitiated: true
            }),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(
                  new Error("WhatsApp audio download timed out. Try again.")
                ),
                25e3
              );
            })
          ]);
        } finally {
          clearTimeout(timer);
        }
        blob = getBlob();
      }
      if (!(blob instanceof Blob) || !blob.size)
        throw new Error(
          "This audio is unavailable to the linked browser. Try downloading it in WhatsApp first."
        );
      const mime = String(message.mimetype || blob.type).split(";")[0].toLowerCase();
      if (!/^audio\/[a-z0-9.+-]+$/.test(mime))
        throw new Error("WhatsApp returned an unsupported audio format.");
      if (offset2 >= blob.size)
        throw new Error("Audio offset is past the end of the file.");
      const bytes = new Uint8Array(
        await blob.slice(offset2, offset2 + 196608).arrayBuffer()
      );
      if (location.origin !== "https://web.whatsapp.com" || (request.targetId ? collections.Chat.get(request.targetId) : collections.Chat.getActive?.()) !== chat || !chat.msgs.getModelsArray().includes(message) || message.isViewOnce)
        throw new Error(
          "The WhatsApp conversation changed during audio download."
        );
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return {
        ok: true,
        messageId: key(message),
        offset: offset2,
        totalBytes: blob.size,
        mime,
        data: btoa(binary),
        nextOffset: offset2 + bytes.length < blob.size ? offset2 + bytes.length : null
      };
    }
    const sorted = () => [...chat.msgs.getModelsArray()].sort(
      (a, b) => Number(b.t) - Number(a.t) || key(b).localeCompare(key(a))
    );
    let messages = sorted();
    let offset = 0;
    if (request.cursor) {
      offset = messages.findIndex((m) => key(m) === request.cursor);
      if (offset < 0)
        throw new Error(
          "WhatsApp unloaded the pagination checkpoint. Start a new collection."
        );
      offset++;
    }
    let exhausted = chat.msgs.msgLoadState?.noEarlierMsgs === true;
    if (offset === messages.length && !exhausted) {
      const loader = window.require("WAWebChatLoadMessages");
      if (typeof loader.loadEarlierMsgs !== "function")
        throw new Error(
          "WhatsApp's history loader changed. Collection stopped."
        );
      const loaded = await loader.loadEarlierMsgs({ chat });
      if (!Array.isArray(loaded))
        throw new Error("WhatsApp returned an unsupported history response.");
      exhausted = loaded.length === 0;
      messages = sorted();
      offset = request.cursor ? messages.findIndex((m) => key(m) === request.cursor) + 1 : 0;
      if (request.cursor && !offset)
        throw new Error(
          "WhatsApp unloaded the pagination checkpoint. Start a new collection."
        );
      if (!exhausted && offset === messages.length)
        throw new Error(
          "WhatsApp did not advance its history checkpoint. Try resuming later."
        );
    }
    const current = id(
      (request.targetId ? collections.Chat.get(request.targetId) : collections.Chat.getActive?.())?.id
    );
    if (current !== threadId)
      throw new Error(
        "The WhatsApp tab changed conversations during collection."
      );
    const batch = messages.slice(offset, offset + 50);
    const normalized = batch.map((m) => {
      const senderId = id(m.author || m.from);
      const contact = collections.Contact?.get(senderId);
      const type = m.type || "unknown";
      const raw = {
        id: key(m),
        timestamp: Number(m.t),
        from: id(m.from),
        to: id(m.to),
        author: id(m.author),
        fromMe: Boolean(m.id?.fromMe),
        type,
        body: m.body || "",
        caption: m.caption || "",
        mimetype: m.mimetype || null,
        filename: m.filename || null,
        quotedMessageId: m.quotedStanzaID || null
      };
      return {
        id: raw.id,
        timestamp: raw.timestamp * 1e3,
        senderId,
        sender: raw.fromMe ? "You" : contact?.name || contact?.pushname || senderId || "Unknown sender",
        isMe: raw.fromMe,
        text: String(m.body || m.caption || `[${type}]`),
        type,
        reactions: [],
        attachments: ["ptt", "audio"].includes(type) && !m.isViewOnce ? [
          {
            type: "audio",
            provider: "whatsapp",
            messageId: raw.id,
            url: `whatsapp:audio/${encodeURIComponent(raw.id)}`,
            mime: raw.mimetype
          }
        ] : [],
        raw
      };
    });
    return {
      ok: true,
      page: {
        messages: normalized,
        hasMore: !exhausted || offset + batch.length < messages.length,
        nextCursor: batch.length ? key(batch.at(-1)) : null
      }
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

// src/platforms.js
var platforms = {
  instagram: {
    id: "instagram",
    label: "Instagram",
    request: instagramRequest,
    matches: (url) => url.origin === "https://www.instagram.com" && /^\/direct\/t\/\d+\/?$/.test(url.pathname),
    capabilities: { media: true, transcribe: true, queryId: true },
    messageRequest: (options) => ({
      queryId: options.queryId || DEFAULT_QUERY_ID
    }),
    transcriptionRequest: () => ({ queryId: TRANSCRIPTION_QUERY_ID }),
    page: (result) => ({
      messages: result.connection?.edges?.filter((e) => e.node).map((e) => normalizeMessage(e.node, result.viewerId)),
      hasMore: result.connection?.page_info?.has_next_page,
      nextCursor: result.connection?.page_info?.end_cursor
    })
  },
  "instagram-saved": {
    id: "instagram-saved",
    label: "Instagram saved posts",
    itemLabel: "posts",
    request: instagramSavedRequest,
    matches: (url) => url.origin === "https://www.instagram.com" && /^\/[^/]+\/saved(?:\/all-posts|\/(?:[^/]+\/)?\d+)?\/?$/.test(
      url.pathname
    ),
    capabilities: { media: false, transcribe: false, queryId: false },
    messageRequest: (options) => ({ collectionId: options.collectionId }),
    page: (result) => result.page
  },
  whatsapp: {
    id: "whatsapp",
    label: "WhatsApp",
    request: whatsappRequest,
    matches: (url) => url.origin === "https://web.whatsapp.com" && url.pathname === "/",
    capabilities: { media: true, transcribe: false, queryId: false },
    messageRequest: () => ({}),
    page: (result) => result.page
  }
};
function platformForUrl(value) {
  try {
    const url = new URL(value);
    return Object.values(platforms).find((p) => p.matches(url)) || null;
  } catch {
    return null;
  }
}
function getPlatform(id = "instagram") {
  const platform = Object.hasOwn(platforms, id) && platforms[id];
  if (!platform) throw new Error("Unsupported conversation platform.");
  return platform;
}

// src/sources.js
function sameSourceUrl(first, second) {
  if (first === second) return true;
  try {
    const a = new URL(first);
    const b = new URL(second);
    const listId = (url) => /!11m\d+!2s([^!]+)/.exec(url.href)?.[1] || /\/placelists\/list\/([^/?]+)/.exec(url.pathname)?.[1];
    return Boolean(
      sourceForUrl(first)?.id === "google-maps" && sourceForUrl(second)?.id === "google-maps" && a.origin === b.origin && listId(a) && listId(a) === listId(b)
    );
  } catch {
    return false;
  }
}
function sourceForUrl(value) {
  const platform = platformForUrl(value);
  if (platform)
    return {
      id: platform.id,
      operation: platform.id === "instagram-saved" ? "saved_posts" : "conversation",
      itemType: platform.id === "instagram-saved" ? "post" : "message"
    };
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && (url.hostname === "www.google.com" && url.pathname.startsWith("/maps") || url.hostname === "maps.google.com"))
      return {
        id: "google-maps",
        operation: "saved_places",
        itemType: "place"
      };
  } catch {
  }
  return null;
}
var siteOrigins = {
  instagram: ["https://www.instagram.com/*"],
  whatsapp: ["https://web.whatsapp.com/*"],
  "google-maps": ["https://www.google.com/maps/*", "https://maps.google.com/*"]
};

// src/source-manager.js
var home = {
  instagram: "https://www.instagram.com/direct/inbox/",
  "instagram-saved": "https://www.instagram.com/",
  whatsapp: "https://web.whatsapp.com/",
  "google-maps": "https://www.google.com/maps/?hl=en"
};
var SourceManager = class {
  constructor(service) {
    this.service = service;
    this.browser = service.browser;
    this.owned = /* @__PURE__ */ new Set();
    this.candidates = /* @__PURE__ */ new Map();
    this.serviceTabs = /* @__PURE__ */ new Map();
  }
  async access(service) {
    if (!home[service]) throw new Error("Unsupported service.");
    const origins = siteOrigins[service === "instagram-saved" ? "instagram" : service];
    if (!await this.browser.permissions.contains({ origins }))
      throw new Error(
        "Enable this website in extension options once. No tab selection is required."
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
        "Service is still loading. Retry discovery; the background tab is retained for login."
      );
    } catch (error) {
      throw new Error(`${error.message} Tab ${tab.id}.`);
    }
  }
  async findTab(service, url) {
    const tabs = await this.browser.tabs.query({});
    return tabs.filter(
      (tab) => this.matchesService(tab, service) && (!url || sameSourceUrl(tab.url, url))
    ).sort(
      (a, b) => Number(Boolean(a.discarded)) - Number(Boolean(b.discarded)) || Number(Boolean(b.active)) - Number(Boolean(a.active)) || (b.lastAccessed || 0) - (a.lastAccessed || 0)
    )[0];
  }
  matchesService(tab, service) {
    if (!tab || tab.incognito) return false;
    try {
      const url = new URL(tab.url);
      return service.startsWith("instagram") ? url.origin === "https://www.instagram.com" : sourceForUrl(tab.url)?.id === service;
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
      tab = await this.findTab(service) || await this.open(home[service]);
      this.serviceTabs.set(service, tab.id);
    }
    let result;
    let activated = false;
    for (let i = 0; i < 10; i++) {
      if (service === "google-maps" && i === 3 && this.browser.tabs.update) {
        await this.browser.tabs.update(tab.id, { active: true });
        activated = true;
      }
      result = service === "instagram-saved" && this.service.instagram ? await this.service.instagram.discover(tab.id, cursor) : await this.service.execute(
        tab.id,
        discoverRequest,
        { service, cursor },
        true
      );
      if (!result.ok && result.ok !== void 0) {
        if (i < 9 && /did not expose|still loading|no collection links are rendered/i.test(
          result.error || ""
        )) {
          await this.service.sleep(800);
          continue;
        }
        throw new Error(
          result.error || "The service could not discover sources."
        );
      }
      if (result.navigate) {
        const target = new URL(result.navigate);
        if (target.origin !== "https://www.instagram.com" || !/^\/[^/]+\/saved\/?$/.test(target.pathname))
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
        tabId: tab.id
      });
      return {
        candidateId,
        id: candidate.id,
        name: candidate.name,
        count: candidate.count,
        users: candidate.users,
        service,
        url: candidate.url
      };
    });
    return {
      candidates,
      nextCursor: result.nextCursor,
      warnings: [
        ...result.warnings || [],
        ...activated ? ["Maps required activating its existing tab to render Saved lists."] : []
      ],
      tabId: tab.id,
      transport: result.transport
    };
  }
  async prepare({ service, url, candidateId, name }) {
    await this.access(service);
    let candidate = candidateId && this.candidates.get(candidateId);
    if (candidateId && (!candidate || candidate.service !== service))
      throw new Error(
        "Candidate expired or belongs to another service. Discover sources again."
      );
    if (!candidate && name) {
      let found = await this.discover({ service });
      const seen = /* @__PURE__ */ new Set();
      while (found.nextCursor && !seen.has(found.nextCursor)) {
        seen.add(found.nextCursor);
        if (seen.size > 100)
          throw new Error("Source discovery exceeded its pagination limit.");
        const page = await this.discover({ service, cursor: found.nextCursor });
        found = {
          ...page,
          candidates: [...found.candidates, ...page.candidates],
          warnings: [
            .../* @__PURE__ */ new Set([...found.warnings || [], ...page.warnings || []])
          ]
        };
      }
      if (found.nextCursor)
        throw new Error("Source discovery repeated its pagination cursor.");
      const query = name.replace(/^@/, "").toLocaleLowerCase();
      const matches = found.candidates.filter(
        (item) => [item.name, ...item.users || []].some(
          (value) => value.toLocaleLowerCase() === query
        )
      );
      if (matches.length !== 1)
        return {
          needsSelection: true,
          ...found,
          reason: matches.length ? "Several sources match. Choose a candidate." : "No exact match on this page. Use candidates or paginate discovery."
        };
      candidate = this.candidates.get(matches[0].candidateId);
    }
    if (candidate?.select) {
      const result = await this.service.execute(
        candidate.tabId,
        discoverRequest,
        {
          service,
          select: candidate.select
        }
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
            "The selected Maps list did not open. Retry discovery."
          );
      }
    } else if (candidate) url = candidate.url;
    if (url && (name || candidateId) && !candidate)
      throw new Error("Choose one target: URL, candidateId, or name.");
    if (!url)
      return { needsSelection: true, ...await this.discover({ service }) };
    const parsed = new URL(url);
    if (parsed.username || parsed.password || sourceForUrl(url)?.id !== service)
      throw new Error(
        "URL does not match the supported service and source type."
      );
    if (service === "instagram-saved" && this.service.instagram) {
      const collectionId = parsed.pathname.match(
        /\/saved\/(?:[^/]+\/)?(\d+)\/?$/
      )?.[1];
      if (!collectionId)
        throw new Error("Choose a named Instagram saved collection.");
      const tab2 = candidate ? await this.browser.tabs.get(candidate.tabId) : await this.findTab(service) || await this.open(home[service]);
      const sourceId2 = crypto.randomUUID();
      this.service.sources.set(sourceId2, {
        sourceId: sourceId2,
        tabId: tab2.id,
        url: tab2.url,
        title: candidate?.name,
        adapter: {
          id: "instagram-saved",
          operation: "saved_posts",
          itemType: "post"
        },
        apiTarget: { collectionId, expectedCount: candidate?.count },
        inUse: true,
        managed: this.owned.has(tab2.id)
      });
      return this.service.describe(sourceId2);
    }
    const tab = service === "whatsapp" && candidate ? await this.browser.tabs.get(candidate.tabId) : await this.findTab(service, url) || await this.open(url);
    if (sourceForUrl(tab.url)?.id !== service)
      throw new Error(
        `The service redirected, possibly to login. Complete login in tab ${tab.id}, then retry.`
      );
    const sourceId = crypto.randomUUID();
    this.service.sources.set(sourceId, {
      sourceId,
      tabId: tab.id,
      url: tab.url,
      title: candidate?.name || tab.title,
      adapter: sourceForUrl(tab.url),
      inUse: true,
      targetId: service === "whatsapp" ? candidate?.id : void 0,
      managed: this.owned.has(tab.id)
    });
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        const current = await this.browser.tabs.get(tab.id);
        const source = this.service.sources.get(sourceId);
        if (sourceForUrl(current.url)?.id !== service)
          throw new Error(
            "The service redirected outside the selected source."
          );
        source.url = current.url;
        source.stale = false;
        try {
          return await this.service.describe(sourceId);
        } catch (error) {
          if (attempt === 9 || !/with its places visible|still loading/i.test(error.message))
            throw error;
          await this.service.sleep(500);
        }
      }
    } catch (error) {
      throw new Error(
        `${error.message} Background tab ${tab.id} is available if login is needed.`
      );
    }
  }
  async release(sourceId) {
    const source = this.service.sources.get(sourceId);
    if (!source) throw new Error("Source not found.");
    if ([...this.service.jobs.values()].some(
      (job) => job.source.tabId === source.tabId && job.state === "running"
    ))
      throw new Error("Wait for or cancel the job before closing its source.");
    this.service.sources.delete(sourceId);
    const referenced = [...this.service.sources.values()].some(
      (other) => other.tabId === source.tabId
    );
    if (!referenced && this.owned.delete(source.tabId)) {
      await this.browser.tabs.remove(source.tabId);
      for (const [key, id] of this.serviceTabs)
        if (id === source.tabId) this.serviceTabs.delete(key);
    }
    return { released: true };
  }
};

// src/runner.js
async function wait(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
async function fetchHistory(session, { request, signal, progress = () => {
}, sleep = wait }) {
  const platform = getPlatform(session.options.platform);
  while (!session.complete) {
    signal?.throwIfAborted();
    let result;
    for (let attempt = 0; attempt < 4; attempt++) {
      result = await request({
        kind: "messages",
        threadId: session.options.threadId,
        cursor: session.cursor,
        ...platform.messageRequest(session.options)
      });
      signal?.throwIfAborted();
      if (result.ok) break;
      if (![429, 500, 502, 503, 504].includes(result.status) || attempt === 3)
        throw new Error(result.error || `${platform.label} request failed.`);
      const retrySeconds = Number(result.retryAfter);
      const delay = Number.isFinite(retrySeconds) && retrySeconds > 0 ? Math.min(retrySeconds * 1e3, 6e4) : 3e3 * 2 ** attempt;
      progress(
        `${platform.label} is busy. Retrying in ${Math.ceil(delay / 1e3)} seconds\u2026`
      );
      await sleep(delay, signal);
    }
    acceptPage(session, platform.page(result));
    progress(
      `${session.messages.length.toLocaleString()} ${platform.itemLabel || "messages"} collected \xB7 ${session.pages} pages`
    );
    if (!session.complete) await sleep(600, signal);
  }
}

// src/google-maps.js
async function mapsListRequest(request) {
  try {
    const url = new URL(location.href);
    if (url.protocol !== "https:" || !["www.google.com", "maps.google.com"].includes(url.hostname) || url.hostname === "www.google.com" && !url.pathname.startsWith("/maps"))
      throw new Error("Open a Google Maps saved list first.");
    const headingNode = document.querySelector(
      'h1,[role="heading"][aria-level="1"]'
    );
    const heading = headingNode?.textContent.trim();
    const listUrl = /(?:placelists\/list\/|!11m)/.test(url.href);
    let panel = document.querySelector('[role="feed"]') || [...document.querySelectorAll('[role="main"]')].find(
      (el) => el.querySelector('a[href*="/maps/place/"]')
    );
    const label = (el) => {
      if (el.getAttribute("aria-label"))
        return el.getAttribute("aria-label").trim();
      const copy = el.cloneNode(true);
      copy.querySelectorAll(
        '[aria-hidden="true"],svg,.google-symbols,.material-icons'
      ).forEach((node) => node.remove());
      return copy.textContent.replace(/\s+/g, " ").trim();
    };
    const placeButtons = (root) => {
      const all = [...root.querySelectorAll('button,[role="button"]')];
      const places = /* @__PURE__ */ new Set();
      const notes = [
        ...all.filter((button) => label(button) === "Add note"),
        ...root.querySelectorAll(
          '[aria-label="Note"],textarea[placeholder="Note"]'
        )
      ];
      for (const note of notes) {
        let parent = note.parentElement;
        for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
          if (parent.querySelector('h1,[role="heading"][aria-level="1"]'))
            break;
          const buttons = [
            ...parent.querySelectorAll('button,[role="button"]')
          ];
          const place = buttons.find((el) => label(el) !== "Add note");
          if (place) {
            places.add(place);
            break;
          }
        }
      }
      return [...places];
    };
    if (!panel && headingNode) {
      let parent = headingNode.parentElement;
      while (parent && parent !== document.body) {
        if (placeButtons(parent).length) {
          panel = parent;
          break;
        }
        parent = parent.parentElement;
      }
    }
    if (!heading || !listUrl || !panel && !/0 places|no places|empty list/i.test(
      document.body.innerText || document.body.textContent || ""
    ) || document.querySelector('[data-item-id="address"]'))
      throw new Error(
        "Open the saved list itself, with its places visible, rather than a place detail or search."
      );
    const listIdentity = /!11m\d+!2s([^!]+)/.exec(url.href)?.[1] || /placelists\/list\/([^/?]+)/.exec(url.href)?.[1];
    const fingerprint = `${url.origin}#${listIdentity || url.pathname}#${heading}`;
    if (request.fingerprint && request.fingerprint !== fingerprint)
      throw new Error(
        "The selected Maps list changed. Select the source again."
      );
    if (request.kind === "context")
      return {
        ok: true,
        threadId: fingerprint,
        title: heading,
        buttonLayout: Boolean(panel && placeButtons(panel).length)
      };
    if (request.kind !== "entries") throw new Error("Unknown Maps request.");
    let scroller = panel && [panel, ...panel.querySelectorAll("div")].filter(
      (el) => el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 100
    ).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (request.reset && scroller) {
      scroller.scrollTop = 0;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const links = [
      ...(panel || document).querySelectorAll('a[href*="/maps/place/"]')
    ];
    const entries = [];
    for (const link of links) {
      const place = new URL(link.href, location.href);
      if (place.origin !== url.origin || !place.pathname.startsWith("/maps/place/"))
        continue;
      place.searchParams.set("hl", "en");
      const name = link.getAttribute("aria-label")?.trim() || link.textContent.trim();
      entries.push({ url: place.href, name: name || null });
    }
    if (!links.length && panel) {
      const names = placeButtons(panel).map(label);
      for (const name of names.filter((name2) => !request.resolvedNames?.includes(name2)).slice(0, request.limit || void 0)) {
        let button = placeButtons(panel).find((el) => label(el) === name);
        if (!button)
          throw new Error(
            "Maps changed its visible place rows while scanning."
          );
        button.click();
        let destination;
        for (let attempt = 0; attempt < 40; attempt++) {
          if (location.pathname.startsWith("/maps/place/")) {
            destination = location.href;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!destination)
          throw new Error(`Maps did not expose the destination for ${name}.`);
        history.back();
        let restored = false;
        for (let attempt = 0; attempt < 40; attempt++) {
          const title = document.querySelector(
            'h1,[role="heading"][aria-level="1"]'
          );
          let parent = title?.parentElement;
          while (parent && parent !== document.body) {
            if (placeButtons(parent).length) {
              panel = parent;
              break;
            }
            parent = parent.parentElement;
          }
          const returned = new URL(location.href);
          const returnedId = /!11m\d+!2s([^!]+)/.exec(returned.href)?.[1] || /placelists\/list\/([^/?]+)/.exec(returned.pathname)?.[1];
          if (returned.origin === url.origin && returnedId === listIdentity && title?.textContent.trim() === heading && panel?.isConnected && placeButtons(panel).length) {
            restored = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!restored)
          throw new Error("Maps did not return to the original saved list.");
        const place = new URL(destination);
        place.searchParams.set("hl", "en");
        entries.push({ name, url: place.href });
      }
    }
    if (!entries.length && !(panel && placeButtons(panel).length) && !/0 places|no places|empty list/i.test(document.body.innerText || ""))
      throw new Error(
        "No supported place links found. Load the list, or its layout may have changed."
      );
    if (panel && !scroller?.isConnected)
      scroller = [panel, ...panel.querySelectorAll("div")].filter(
        (el) => el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 100
      ).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    const before = scroller?.scrollTop || 0;
    const atEnd = !scroller || before + scroller.clientHeight >= scroller.scrollHeight - 5;
    if (scroller)
      scroller.scrollTop = before + Math.max(300, scroller.clientHeight * 0.8);
    const countText = (panel || document).innerText || (panel || document).textContent || "";
    const expected = /([\d,]+)\s+places?\b/i.exec(countText);
    return {
      ok: true,
      entries,
      atEnd,
      expectedCount: expected ? Number(expected[1].replaceAll(",", "")) : null
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
async function mapsPlaceRequest() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (!["www.google.com", "maps.google.com"].includes(location.hostname) || !location.pathname.startsWith("/maps/place/"))
    return { ok: false, error: "The place redirected outside Google Maps." };
  for (let attempt = 0; attempt < 30; attempt++) {
    const addressNode = document.querySelector('[data-item-id="address"]');
    const details = addressNode?.closest('[role="main"]') || document;
    const titleNode = [...details.querySelectorAll("h1")].at(-1);
    const title = titleNode?.textContent.trim();
    const address = (addressNode?.getAttribute("aria-label")?.replace(/^Address:\s*/i, "") || addressNode?.querySelector(".fontBodyMedium")?.textContent || "").trim();
    if (title && (address || attempt === 29)) {
      const hoursButton = details.querySelector(
        '[data-item-id="oh"], button[aria-label*="Show open hours"], [role="button"][aria-label*="Show open hours"]'
      );
      hoursButton?.click();
      if (hoursButton) await sleep(400);
      const hours = [...details.querySelectorAll("table tr")].map((row) => {
        const cells = [...row.querySelectorAll("td")].map(
          (el) => el.textContent.replace(new RegExp("\\p{Co}", "gu"), "").trim()
        );
        return cells.length >= 2 && /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.test(
          cells[0]
        ) && cells.slice(1).some(Boolean) ? { day: cells[0], hours: cells.slice(1).join(" ") } : null;
      }).filter(Boolean);
      const labels = [...details.querySelectorAll("[aria-label]")].map(
        (el) => el.getAttribute("aria-label")
      );
      const ratingLabel = labels.find(
        (label) => /^\d(?:[.,]\d+)?\s+(?:stars|out of 5)/i.test(label)
      );
      const reviewLabel = labels.find(
        (label) => /^[\d,.]+\s+reviews\b/i.test(label)
      );
      const rating = ratingLabel ? Number(ratingLabel.match(/^[\d.,]+/)[0].replace(",", ".")) : null;
      const reviewCount = reviewLabel ? Number(reviewLabel.match(/^[\d,.]+/)[0].replace(/[,.]/g, "")) : null;
      return {
        ok: true,
        entry: {
          name: title,
          address: address || null,
          hours: hours.length ? hours : null,
          hoursSummary: hoursButton?.getAttribute("aria-label") || null,
          rating,
          reviewCount,
          url: location.href,
          unavailableFields: [
            !address && "address",
            !hours.length && "hours",
            rating === null && "rating",
            reviewCount === null && "reviewCount"
          ].filter(Boolean)
        }
      };
    }
    await sleep(500);
  }
  return {
    ok: false,
    error: "Place details did not load. Check Maps consent or sign-in prompts."
  };
}

// src/whatsapp-media.js
function isWhatsAppAudio(attachment) {
  return attachment.provider === "whatsapp" && attachment.type === "audio" && typeof attachment.messageId === "string" && attachment.messageId.length > 0 && attachment.url === `whatsapp:audio/${encodeURIComponent(attachment.messageId)}`;
}

// src/scrape-service.js
var ScrapeService = class {
  constructor(browser, { sleep = wait } = {}) {
    this.browser = browser;
    this.sleep = sleep;
    this.sources = /* @__PURE__ */ new Map();
    this.jobs = /* @__PURE__ */ new Map();
    this.instagram = new InstagramApi({ execute: this.execute.bind(this) });
    this.manager = new SourceManager(this);
    browser.tabs.onUpdated.addListener((id, change) => {
      if (change.status === "loading") this.invalidate(id);
      else if (change.url) {
        for (const source of this.sources.values()) {
          if (source.tabId !== id) continue;
          if (source.apiTarget) continue;
          if (sameSourceUrl(source.url, change.url)) source.url = change.url;
          else source.stale = true;
        }
      }
    });
    browser.tabs.onRemoved.addListener((id) => this.invalidate(id));
  }
  invalidate(tabId) {
    for (const source of this.sources.values())
      if (source.tabId === tabId && !source.apiTarget) source.stale = true;
  }
  async execute(tabId, func, request, allowFailure = false) {
    const [result] = await this.browser.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func,
      args: [request]
    });
    if (!result?.result || !result.result.ok && !allowFailure)
      throw new Error(result?.result?.error || "The page did not respond.");
    return result.result;
  }
  async listTabs() {
    const tabs = await this.browser.tabs.query({});
    for (const [id, source] of this.sources)
      if (!source.inUse) this.sources.delete(id);
    return Promise.all(
      tabs.filter((tab) => !tab.incognito && sourceForUrl(tab.url)).map(async (tab) => {
        const adapter = sourceForUrl(tab.url);
        const origins = siteOrigins[adapter.id === "instagram-saved" ? "instagram" : adapter.id];
        const hasAccess = await this.browser.permissions.contains({
          origins
        });
        const sourceId = crypto.randomUUID();
        this.sources.set(sourceId, {
          sourceId,
          tabId: tab.id,
          url: tab.url,
          adapter,
          title: tab.title
        });
        return {
          sourceId,
          tabId: tab.id,
          windowId: tab.windowId,
          title: tab.title,
          url: tab.url,
          ...adapter,
          hasAccess,
          accessSetup: hasAccess ? null : "Open the extension options and enable this website. Do not select the tab again in Chrome."
        };
      })
    );
  }
  async selected(sourceId) {
    const source = this.sources.get(sourceId);
    if (!source || source.stale)
      throw new Error("Source expired or changed. List tabs and select again.");
    const tab = source.apiTarget ? null : await this.browser.tabs.get(source.tabId);
    if (tab && !sameSourceUrl(tab.url, source.url))
      throw new Error(
        "The selected tab navigated. List tabs and select again."
      );
    if (tab) source.url = tab.url;
    const origins = siteOrigins[source.adapter.id === "instagram-saved" ? "instagram" : source.adapter.id];
    if (!await this.browser.permissions.contains({ origins }))
      throw new Error(
        "Website access is missing. Enable it in extension options; tab selection stays in your agent."
      );
    return source;
  }
  async describe(sourceId, options = {}) {
    const source = await this.selected(sourceId);
    if (source.apiTarget && options.collectionId && options.collectionId !== source.apiTarget.collectionId)
      throw new Error(
        "Prepare the other saved collection before changing collectionId."
      );
    const context = source.apiTarget ? await this.instagram.context(
      source.tabId,
      options.collectionId || source.apiTarget.collectionId,
      source.title
    ) : await this.execute(
      source.tabId,
      source.adapter.id === "google-maps" ? mapsListRequest : getPlatform(source.adapter.id).request,
      {
        kind: "context",
        collectionId: options.collectionId,
        targetId: source.targetId
      }
    );
    if (source.context && source.context.threadId !== context.threadId && source.collectionId === options.collectionId)
      throw new Error(
        "The selected conversation or list changed. List tabs and select again."
      );
    source.context = context;
    source.collectionId = options.collectionId;
    return {
      sourceId,
      ...source.adapter,
      title: context.title,
      sourceIdentity: context.threadId,
      options: source.adapter.id === "instagram-saved" ? ["collectionId", "limit"] : source.adapter.id === "google-maps" ? ["limit"] : ["limit", "start", "end"],
      warnings: context.warnings || []
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
      transport: job.transport
    };
  }
  async start({ sourceId, options = {} }) {
    if ([...this.jobs.values()].filter((job2) => job2.state === "running").length >= 2)
      throw new Error("Two jobs are already running. Wait or cancel one.");
    if (this.jobs.size >= 20)
      throw new Error(
        "Delete an old job with delete_job before starting another."
      );
    const source = await this.selected(sourceId);
    if ([...this.jobs.values()].some(
      (job2) => job2.source.tabId === source.tabId && job2.state === "running"
    ))
      throw new Error("A job is already using this tab.");
    await this.describe(sourceId, options);
    if (options.limit != null && (!Number.isSafeInteger(options.limit) || options.limit < 1))
      throw new Error("limit must be a positive integer.");
    if (options.start != null && !Number.isFinite(options.start) || options.end != null && !Number.isFinite(options.end))
      throw new Error("Dates must be epoch milliseconds.");
    if (options.start != null && options.end != null && options.start > options.end)
      throw new Error("The start date must precede the end date.");
    if (source.adapter.operation !== "conversation" && (options.start != null || options.end != null))
      throw new Error("Date filters apply only to conversations.");
    const job = {
      id: crypto.randomUUID(),
      source: { ...source },
      title: source.context.title,
      items: [],
      warnings: [...source.context.warnings || []],
      state: "running",
      complete: false,
      progress: "Starting",
      options,
      controller: new AbortController()
    };
    source.inUse = true;
    if (source.adapter.id !== "google-maps")
      job.session = createSession({
        platform: source.adapter.id,
        start: null,
        end: null,
        ...options,
        threadId: source.context.threadId
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
            const result = job.source.apiTarget ? await this.instagram.posts(
              job.source.tabId,
              job.source.apiTarget.collectionId,
              request.cursor,
              job.source.context.threadId
            ) : await this.execute(
              job.source.tabId,
              getPlatform(job.source.adapter.id).request,
              { ...request, targetId: job.source.targetId },
              true
            );
            await this.check(job);
            for (const warning of result.warnings || [])
              if (!job.warnings.includes(warning)) job.warnings.push(warning);
            if (result.transport) job.transport = result.transport;
            return result;
          }
        });
      job.complete = job.source.adapter.id === "google-maps" ? job.listComplete : job.session.complete;
      const expected = job.source.apiTarget?.expectedCount;
      if (job.complete && Number.isSafeInteger(expected) && job.session.messages.length !== expected) {
        job.warnings.push(
          `The collection reports ${expected} posts, but its available API feed returned ${job.session.messages.length}. Coverage is incomplete; unavailable or removed posts may account for the difference.`
        );
        job.complete = false;
      }
      job.state = job.complete ? "complete" : "partial";
      job.progress = job.complete ? "Finished" : "Finished with incomplete coverage";
    } catch (error) {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.error = error.message;
    }
  }
  async collectMaps(job) {
    let scanTab;
    try {
      if (!job.places && job.source.context.buttonLayout) {
        scanTab = await this.manager.open(job.source.url);
        for (let attempt = 0; attempt < 10; attempt++) {
          const context = await this.execute(
            scanTab.id,
            mapsListRequest,
            { kind: "context" },
            true
          );
          if (context.ok) {
            if (context.threadId !== job.source.context.threadId)
              throw new Error("The scan tab opened a different Maps list.");
            break;
          }
          if (attempt === 9) throw new Error(context.error);
          await this.sleep(500, job.controller.signal);
        }
      }
      await this.collectMapsFromTab(job, scanTab?.id || job.source.tabId);
    } finally {
      if (scanTab) {
        this.manager.owned.delete(scanTab.id);
        await this.browser.tabs.remove(scanTab.id).catch(() => {
        });
      }
    }
  }
  async collectMapsFromTab(job, scanTabId) {
    const signal = job.controller.signal;
    if (!job.places) {
      const places = job.discoveredPlaces ||= /* @__PURE__ */ new Map();
      let stable = 0, expected = null;
      const started = Date.now();
      while (stable < 4) {
        await this.check(job);
        if (Date.now() - started > 3e5)
          throw new Error(
            "List discovery timed out. The job is partial; retry after Maps finishes loading."
          );
        const page = await this.execute(scanTabId, mapsListRequest, {
          kind: "entries",
          fingerprint: job.source.context.threadId,
          reset: !job.scanStarted,
          resolvedNames: [...places.values()].map((entry) => entry.name),
          limit: job.options.limit ? job.options.limit - places.size : void 0
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
        job.options.limit || void 0
      );
      job.listComplete = Boolean(job.options.limit && places.size >= job.options.limit) || expected !== null && places.size === expected;
      if (!job.listComplete)
        job.warnings.push(
          "Maps stopped loading more places, but did not expose a matching total. Coverage is unverified; results are marked partial."
        );
    }
    for (let i = job.items.length; i < job.places.length; i++) {
      await this.check(job);
      const place = job.places[i];
      let detailTab;
      try {
        detailTab = await this.browser.tabs.create({
          url: place.url,
          active: false
        });
        const started = Date.now();
        while (true) {
          signal.throwIfAborted();
          const tab = await this.browser.tabs.get(detailTab.id);
          if (tab.status === "complete" && sourceForUrl(tab.url)?.id === "google-maps")
            break;
          if (Date.now() - started > 3e4)
            throw new Error("Place tab did not load within 30 seconds.");
          await this.sleep(300, signal);
        }
        const result = await this.execute(detailTab.id, mapsPlaceRequest, {});
        await this.check(job);
        job.items.push({ ...result.entry, id: place.url, type: "place" });
        if (result.entry.unavailableFields.length)
          job.warnings.push(
            `${result.entry.name}: unavailable ${result.entry.unavailableFields.join(", ")}`
          );
      } finally {
        if (detailTab)
          await this.browser.tabs.remove(detailTab.id).catch(() => {
          });
      }
      job.progress = `${job.items.length} / ${job.places.length} places`;
      await this.sleep(600, signal);
    }
  }
  get(jobId) {
    const job = this.jobs.get(jobId);
    if (!job)
      throw new Error(
        "Job not found. Jobs are cleared when the extension restarts or is disconnected."
      );
    return job;
  }
  results({ jobId, offset = 0, limit = 25 }) {
    const job = this.get(jobId);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Use offset >= 0 and limit between 1 and 100.");
    const all = job.session?.messages || job.items;
    const items = [];
    let bytes = 0;
    for (const original of all.slice(offset, offset + limit)) {
      const { raw, ...item } = original;
      const size = new TextEncoder().encode(JSON.stringify(item)).length;
      if (bytes + size > 6e5) break;
      bytes += size;
      items.push(item);
    }
    if (!items.length && offset < all.length)
      throw new Error(
        "An individual item exceeds the bridge response limit. Use the manual exporter for this source."
      );
    return {
      ...this.status(job),
      itemType: job.source.adapter.itemType,
      offset,
      items,
      nextOffset: offset + items.length < all.length ? offset + items.length : null
    };
  }
  async voiceNote({ jobId, messageId, offset = 0 }) {
    const job = this.get(jobId);
    if (job.source.adapter.id !== "whatsapp")
      throw new Error("Voice-note downloads require a WhatsApp job.");
    if (job.state === "running")
      throw new Error("Wait for collection to stop before downloading audio.");
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Audio offset must be a nonnegative integer.");
    const message = job.session.messages.find((m) => m.id === messageId);
    if (!message?.attachments?.some(isWhatsAppAudio))
      throw new Error("This job has no downloadable audio for that message.");
    await this.selected(job.source.sourceId);
    const result = await this.execute(
      job.source.tabId,
      getPlatform("whatsapp").request,
      {
        kind: "media",
        threadId: job.session.options.threadId,
        targetId: job.source.targetId,
        messageId,
        offset
      }
    );
    await this.selected(job.source.sourceId);
    this.get(jobId);
    return result;
  }
  async handle(method, params = {}) {
    if (method === "browser_info")
      return {
        profile: (await this.browser.storage.local.get("bridgeProfile")).bridgeProfile || null
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
          "Collection discovery is supported on Instagram Saved tabs. Open a Maps list directly."
        );
      const result = await this.execute(
        source.tabId,
        getPlatform(source.adapter.id).request,
        {
          kind: "collections",
          cursor: params.cursor,
          threadId: source.context?.threadId,
          collectionId: source.collectionId
        }
      );
      return { collections: result.collections, nextCursor: result.nextCursor };
    }
    if (method === "start_scrape") return this.start(params);
    if (method === "get_status") return this.status(this.get(params.jobId));
    if (method === "get_results") return this.results(params);
    if (method === "get_voice_note") return this.voiceNote(params);
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
};

// src/native-bridge.js
function installNativeBridge(browser) {
  let port;
  let service;
  let connecting = false;
  async function connect() {
    if (port || connecting) return;
    connecting = true;
    try {
      const { bridgeEnabled } = await browser.storage.local.get("bridgeEnabled");
      if (!bridgeEnabled) return;
      service ||= new ScrapeService(browser);
      port = browser.runtime.connectNative("org.scraper_extension.bridge");
      const current = port;
      port.onMessage.addListener((message) => {
        if (typeof message?.id !== "string" || typeof message.method !== "string")
          return;
        service.handle(message.method, message.params).then(
          (result) => {
            try {
              current.postMessage({ id: message.id, result });
            } catch {
            }
          },
          (error) => {
            try {
              current.postMessage({ id: message.id, error: error.message });
            } catch {
            }
          }
        );
      });
      port.onDisconnect.addListener(() => {
        const error = browser.runtime.lastError?.message;
        if (port === current) port = null;
        browser.storage.local.set({ bridgeStatus: error || "Disconnected" });
      });
      await browser.storage.local.set({
        bridgeStatus: "Connecting to local host"
      });
    } finally {
      connecting = false;
    }
  }
  browser.runtime.onStartup.addListener(connect);
  browser.runtime.onInstalled.addListener(connect);
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.bridgeEnabled) return;
    if (changes.bridgeEnabled.newValue) connect();
    else {
      for (const job of service?.jobs.values() || [])
        job.controller.abort(new Error("Integration disconnected"));
      port?.disconnect();
      port = null;
    }
  });
  browser.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL("options.html"))
      return;
    if (message?.type === "reconnect-native") {
      port?.disconnect();
      port = null;
      connect().then(
        () => reply({ ok: true }),
        (error) => reply({ error: error.message })
      );
      return true;
    }
  });
  connect();
}

// src/background.js
installNativeBridge(chrome);
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.tabs.create({
    url: chrome.runtime.getURL("app.html") + "?tab=" + tab.id
  });
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("app.html")) || sender.tab?.url?.startsWith("https://"))
    return;
  if (message.type !== "platform" || !Number.isInteger(message.tabId)) return;
  (async () => {
    const tab = await chrome.tabs.get(message.tabId);
    const platform = platformForUrl(tab.url);
    if (!platform)
      throw new Error(
        "Open an Instagram conversation, your Instagram Saved page (All posts), or a WhatsApp chat and click the extension icon again."
      );
    if (message.platform && platform.id !== message.platform)
      throw new Error(
        "The source tab changed platforms. Reconnect before collecting."
      );
    if (!["context", "messages", "transcription", "media"].includes(
      message.request?.kind
    ))
      throw new Error("Unknown request.");
    if (message.request.kind === "media" && platform.id !== "whatsapp")
      throw new Error("Page audio downloads are only available for WhatsApp.");
    if (message.request.kind === "transcription" && !platform.capabilities.transcribe)
      throw new Error("Transcription is unavailable for this platform.");
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: message.tabId },
      world: "MAIN",
      func: platform.request,
      args: [message.request]
    });
    if (!result?.result)
      return { ok: false, error: `${platform.label} did not respond.` };
    return { ...result.result, platform: platform.id };
  })().then(reply, (error) => reply({ ok: false, error: error.message }));
  return true;
});
