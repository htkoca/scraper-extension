// src/discovery.js
async function discoverRequest({ service, cursor }) {
  try {
    if (service === "whatsapp") {
      if (location.origin !== "https://web.whatsapp.com")
        throw new Error("Unexpected service origin.");
      const store = window.require?.("WAWebCollections");
      if (!store?.Chat?.getModelsArray)
        throw new Error("WhatsApp is still loading or needs QR login.");
      return {
        ok: true,
        candidates: store.Chat.getModelsArray().map((chat) => ({
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
      if (!response.ok)
        throw new Error(
          `Instagram discovery returned HTTP ${response.status}.`
        );
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
      const candidates = [...document.querySelectorAll("a[href]")].filter((link) => /placelists\/list\/|!11m/.test(link.href)).map((link) => ({
        id: link.href,
        url: link.href,
        name: link.getAttribute("aria-label") || link.textContent.trim()
      })).filter((item) => item.name);
      if (candidates.length)
        return {
          ok: true,
          candidates: [
            ...new Map(candidates.map((item) => [item.url, item])).values()
          ],
          nextCursor: null
        };
      const saved = [
        ...document.querySelectorAll('button,[role="button"]')
      ].find(
        (el) => /^(Saved|Your places)$/i.test(
          el.getAttribute("aria-label") || el.textContent.trim()
        )
      );
      if (saved) {
        saved.click();
        return { ok: true, pending: true, candidates: [] };
      }
      throw new Error(
        "Maps did not expose saved-list links. Supply the saved list URL, or open Saved in Maps once."
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
          "Captions and post links only. Dates are publication dates, not dates saved. Posts without captions are retained."
        ]
      };
    if (request.kind === "collections") {
      const params2 = new URLSearchParams({
        collection_types: '["ALL_MEDIA_AUTO_COLLECTION","MEDIA"]'
      });
      if (request.cursor) params2.set("max_id", request.cursor);
      const response2 = await fetch("/api/v1/collections/list/?" + params2, {
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.timeout(25e3),
        headers: { "X-CSRFToken": csrf, "X-IG-App-ID": "936619743392459" }
      });
      if (!response2.ok)
        throw new Error(
          `Instagram returned HTTP ${response2.status} while listing collections.`
        );
      const body2 = await response2.json();
      if (body2.status !== "ok" || !Array.isArray(body2.items))
        throw new Error("Instagram returned an unsupported collection list.");
      const collections = body2.items.map((item) => ({
        id: String(item.collection_id || item.id || ""),
        name: item.collection_name || item.name,
        count: Number.isSafeInteger(item.collection_media_count) ? item.collection_media_count : null
      })).filter(
        (item) => /^\d+$/.test(item.id) && typeof item.name === "string"
      );
      if (collections.length !== body2.items.length)
        throw new Error("A collection is missing its name or numeric ID.");
      const nextCursor = body2.more_available ? body2.next_max_id || body2.max_id : null;
      if (body2.more_available && (!nextCursor || nextCursor === request.cursor))
        throw new Error("Instagram repeated a collection cursor.");
      return { ok: true, collections, nextCursor: nextCursor || null };
    }
    if (request.kind !== "messages")
      throw new Error("Unsupported saved-post request.");
    const params = new URLSearchParams({
      count: "30",
      include_igtv_preview: "false"
    });
    if (request.cursor) params.set("max_id", request.cursor);
    const endpoint = collectionId ? `/api/v1/feed/collection/${collectionId}/` : "/api/v1/feed/saved/posts/";
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
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(
        "Instagram returned a non-JSON response. Check your login or account prompts."
      );
    }
    if (body.status !== "ok" || !Array.isArray(body.items) || typeof body.more_available !== "boolean")
      throw new Error(
        "Instagram did not return a supported saved-post page. Reload Instagram and try again."
      );
    const messages = body.items.map((item) => {
      const post = item.media || item;
      const id = String(post.pk || post.id || "");
      if (!id || !/^[A-Za-z0-9_-]+$/.test(post.code || "") || !Number.isFinite(post.taken_at) || post.taken_at < 0 || post.caption != null && typeof post.caption.text !== "string")
        throw new Error(
          "A saved post has unsupported caption or metadata fields. Collection paused."
        );
      const caption = post.caption?.text || "";
      const url = `https://www.instagram.com/p/${post.code}/`;
      const author = post.user?.username || "Unknown author";
      return {
        id,
        timestamp: post.taken_at * 1e3,
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
    if (!message.id || !Number.isFinite(message.timestamp) || message.timestamp < 0)
      throw new Error(
        "A message has an invalid ID or timestamp. Collection paused."
      );
  }
  let older = false, limitReached = false;
  for (const message of normalized) {
    if (session.options.start !== null && message.timestamp < session.options.start) {
      older = true;
      continue;
    }
    if (session.options.end !== null && message.timestamp > session.options.end)
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
    if (!["context", "messages"].includes(request.kind))
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
          "WhatsApp exports history available to this linked browser. Older phone history may be unavailable. Attachments are recorded as metadata. Media downloads, reactions, and voice transcription are not supported yet."
        ]
      };
    const key = (message) => id(message.id);
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
        attachments: [],
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
    capabilities: { media: false, transcribe: false, queryId: false },
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
        cursor
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
        tabId: tab.id
      });
      return {
        candidateId,
        name: candidate.name,
        users: candidate.users,
        service,
        url: candidate.url
      };
    });
    return {
      candidates,
      nextCursor: result.nextCursor,
      warnings: result.warnings || [],
      tabId: tab.id
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
      const found = await this.discover({ service });
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
    if (candidate) url = candidate.url;
    if (url && (name || candidateId) && !candidate)
      throw new Error("Choose one target: URL, candidateId, or name.");
    if (!url)
      return { needsSelection: true, ...await this.discover({ service }) };
    const parsed = new URL(url);
    if (parsed.username || parsed.password || sourceForUrl(url)?.id !== service)
      throw new Error(
        "URL does not match the supported service and source type."
      );
    const tab = service === "whatsapp" && candidate ? await this.browser.tabs.get(candidate.tabId) : await this.open(url);
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
      return await this.service.describe(sourceId);
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
    if (this.owned.delete(source.tabId)) {
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
    const heading = document.querySelector('[role="main"] h1, h1')?.textContent.trim();
    const listUrl = /(?:placelists\/list\/|!11m)/.test(url.href);
    const panel = document.querySelector('[role="feed"]') || [...document.querySelectorAll('[role="main"]')].find(
      (el) => el.querySelector('a[href*="/maps/place/"]')
    );
    if (!heading || !listUrl || document.querySelector('[data-item-id="address"]'))
      throw new Error(
        "Open the saved list itself, with its places visible, rather than a place detail or search."
      );
    const fingerprint = `${location.href}#${heading}`;
    if (request.fingerprint && request.fingerprint !== fingerprint)
      throw new Error(
        "The selected Maps list changed. Select the source again."
      );
    if (request.kind === "context")
      return { ok: true, threadId: fingerprint, title: heading };
    if (request.kind !== "entries") throw new Error("Unknown Maps request.");
    const scroller = panel && [panel, ...panel.querySelectorAll("div")].filter(
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
    if (!entries.length && !/0 places|no places|empty list/i.test(document.body.innerText || ""))
      throw new Error(
        "No supported place links found. Load the list, or its layout may have changed."
      );
    const before = scroller?.scrollTop || 0;
    const atEnd = !scroller || before + scroller.clientHeight >= scroller.scrollHeight - 5;
    if (scroller)
      scroller.scrollTop = before + Math.max(300, scroller.clientHeight * 0.8);
    const countText = (panel || document).innerText || (panel || document).textContent || "";
    const expected = /([\d,]+)\s+places\b/i.exec(countText);
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
    const title = document.querySelector("h1")?.textContent.trim();
    const address = document.querySelector('[data-item-id="address"]')?.getAttribute("aria-label")?.replace(/^Address:\s*/i, "") || document.querySelector('[data-item-id="address"] .fontBodyMedium')?.textContent.trim();
    if (title && (address || attempt === 29)) {
      const hoursButton = document.querySelector(
        '[data-item-id="oh"], button[aria-label*="Show open hours"], [role="button"][aria-label*="Show open hours"]'
      );
      hoursButton?.click();
      if (hoursButton) await sleep(400);
      const hours = [...document.querySelectorAll("table tr")].map((row) => {
        const cells = [...row.querySelectorAll("td")].map(
          (el) => el.textContent.trim()
        );
        return cells.length >= 2 ? { day: cells[0], hours: cells.slice(1).join(" ") } : null;
      }).filter(Boolean);
      const labels = [...document.querySelectorAll("[aria-label]")].map(
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

// src/scrape-service.js
var ScrapeService = class {
  constructor(browser, { sleep = wait } = {}) {
    this.browser = browser;
    this.sleep = sleep;
    this.sources = /* @__PURE__ */ new Map();
    this.jobs = /* @__PURE__ */ new Map();
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
    const tab = await this.browser.tabs.get(source.tabId);
    if (tab.url !== source.url)
      throw new Error(
        "The selected tab navigated. List tabs and select again."
      );
    const origins = siteOrigins[source.adapter.id === "instagram-saved" ? "instagram" : source.adapter.id];
    if (!await this.browser.permissions.contains({ origins }))
      throw new Error(
        "Website access is missing. Enable it in extension options; tab selection stays in Codex."
      );
    return source;
  }
  async describe(sourceId, options = {}) {
    const source = await this.selected(sourceId);
    const context = await this.execute(
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
      warningCount: job.warnings.length
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
            const result = await this.execute(
              job.source.tabId,
              getPlatform(job.source.adapter.id).request,
              { ...request, targetId: job.source.targetId },
              true
            );
            await this.check(job);
            return result;
          }
        });
      job.complete = job.source.adapter.id === "google-maps" ? job.listComplete : job.session.complete;
      job.state = job.complete ? "complete" : "partial";
      job.progress = job.complete ? "Finished" : "Finished with incomplete coverage";
    } catch (error) {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.error = error.message;
    }
  }
  async collectMaps(job) {
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
        const page = await this.execute(job.source.tabId, mapsListRequest, {
          kind: "entries",
          fingerprint: job.source.context.threadId,
          reset: !job.scanStarted
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
    if (!["context", "messages", "transcription"].includes(message.request?.kind))
      throw new Error("Unknown request.");
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
