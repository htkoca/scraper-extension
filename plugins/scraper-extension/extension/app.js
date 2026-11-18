// src/instagram-saved.js
async function instagramSavedRequest(request2) {
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
    const collectionId = request2.collectionId || pathCollection;
    if (collectionId && !/^\d+$/.test(collectionId))
      throw new Error(
        "This saved collection URL has no numeric collection ID. Open the collection itself."
      );
    const threadId = collectionId ? `saved-${viewerId}-${collectionId}` : `saved-${viewerId}`;
    if (request2.threadId && request2.threadId !== threadId)
      throw new Error(
        "The Instagram account changed or the selected collection changed. Return to the original source to resume."
      );
    if (request2.kind === "context")
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
    if (request2.kind === "collections") {
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
          ...request2.cursor ? { after: request2.cursor } : {}
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
      if (connection.page_info.has_next_page && (!nextCursor || nextCursor === request2.cursor))
        throw new Error("Instagram repeated a collection cursor.");
      return { ok: true, collections, nextCursor, transport: "source-tab" };
    }
    if (request2.kind !== "messages")
      throw new Error("Unsupported saved-post request.");
    const params = new URLSearchParams({
      count: "30",
      include_igtv_preview: "false"
    });
    if (request2.cursor) params.set("max_id", request2.cursor);
    const endpoint = collectionId ? `/api/v1/feed/collection/${collectionId}/` : "/api/v1/feed/saved/posts/";
    let body;
    if (collectionId) {
      const result = await graphql(
        "PolarisSavedCollectionPageWWWQuery",
        "39910535158594768",
        {
          after: request2.cursor || null,
          collection_id: collectionId,
          first: 12,
          __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true,
          __relay_internal__pv__PolarisSEOIsCrawlerrelayprovider: false
        }
      );
      if (!result.ok) return result;
      const collection = result.data.fetch__MediaCollection, media2 = collection?.media;
      if (String(collection?.id) !== collectionId || !Array.isArray(media2?.edges) || typeof media2.page_info?.has_next_page !== "boolean")
        throw new Error("Instagram saved collection contents changed.");
      body = {
        status: "ok",
        items: media2.edges.map(({ node }) => node),
        more_available: media2.page_info.has_next_page,
        next_max_id: media2.page_info.end_cursor
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
async function instagramRequest(request2) {
  try {
    if (location.origin !== "https://www.instagram.com")
      throw new Error("Open a conversation on www.instagram.com first.");
    const threadId = location.pathname.match(/^\/direct\/t\/(\d+)\/?$/)?.[1];
    if (!threadId) throw new Error("Open an Instagram conversation first.");
    if (request2.threadId && request2.threadId !== threadId)
      throw new Error(
        "The Instagram tab changed conversations. Return to the original conversation to resume."
      );
    if (request2.kind === "context")
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
    const transcription = request2.kind === "transcription";
    const friendly = transcription ? "IGDAudioTranscriptionButtonOffMsysMutation" : "IGDMessageListOffMsysQuery";
    let queryId = request2.queryId;
    try {
      queryId = window.require?.(friendly + ".graphql")?.params?.id || queryId;
    } catch {
    }
    const variables = transcription ? { input: { media_id: request2.mediaId } } : {
      id: threadId,
      first: 20,
      after: request2.cursor || null,
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
function parseDateRange(from, to) {
  const start = from ? (/* @__PURE__ */ new Date(from + "T00:00:00")).getTime() : null;
  const end = to ? (/* @__PURE__ */ new Date(to + "T23:59:59.999")).getTime() : null;
  if (start !== null && !Number.isFinite(start) || end !== null && !Number.isFinite(end))
    throw new Error("Choose valid dates.");
  if (start !== null && end !== null && start > end)
    throw new Error("The start date must be before the end date.");
  return { start, end };
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
function acceptPage(session2, connection) {
  const saved = session2.options.platform === "instagram-saved";
  if (saved && (session2.options.start != null || session2.options.end != null))
    throw new Error("Date filters are unavailable for saved posts.");
  if (!Array.isArray(connection?.messages) || typeof connection.hasMore !== "boolean")
    throw new Error("Unsupported conversation response.");
  const next = connection.nextCursor;
  const more = connection.hasMore;
  if (more && (!next || next === session2.cursor || session2.cursors.has(next)))
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
    if (session2.options.start != null && message.timestamp < session2.options.start) {
      older = true;
      continue;
    }
    if (session2.options.end != null && message.timestamp > session2.options.end)
      continue;
    if (session2.seen.has(message.id)) continue;
    if (session2.options.limit && session2.messages.length >= session2.options.limit) {
      limitReached = true;
      break;
    }
    session2.seen.add(message.id);
    session2.messages.push(message);
  }
  session2.pages++;
  if (next) session2.cursors.add(next);
  session2.cursor = next || null;
  session2.complete = !more || older || limitReached || Boolean(
    session2.options.limit && session2.messages.length >= session2.options.limit
  );
}
function chronological(messages) {
  return [...messages].sort(
    (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)
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
      const context2 = path + " " + value.split("?")[0];
      const type = /audio|voice|opus|m4a|aac|mp3/i.test(context2) ? "audio" : /video|playable|mp4|webm/i.test(context2) ? "video" : /gif|animated/i.test(context2) ? "gif" : /image|photo|preview|thumbnail|jpe?g|png|webp/i.test(context2) ? "image" : "other";
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
async function whatsappRequest(request2) {
  try {
    if (location.origin !== "https://web.whatsapp.com")
      throw new Error("Open web.whatsapp.com first.");
    if (!["context", "messages", "media"].includes(request2.kind))
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
    const chat = request2.targetId ? collections.Chat.get(request2.targetId) : collections.Chat.getActive?.();
    const threadId = id(chat?.id);
    if (!threadId) throw new Error("Open a WhatsApp conversation first.");
    if (request2.threadId && request2.threadId !== threadId)
      throw new Error(
        "The WhatsApp tab changed conversations. Return to the original conversation to resume."
      );
    if (!chat?.msgs?.getModelsArray)
      throw new Error(
        "This WhatsApp conversation is not loaded. Reopen it and try again."
      );
    if (request2.kind === "context")
      return {
        ok: true,
        threadId,
        title: chat.formattedTitle || chat.name || threadId,
        warnings: [
          "WhatsApp exports history available to this linked browser. Older phone history may be unavailable. Voice notes and audio can be downloaded in a ZIP. Other media, reactions, and voice transcription are not supported."
        ]
      };
    const key = (message) => id(message.id);
    if (request2.kind === "media") {
      const offset2 = request2.offset ?? 0;
      if (!request2.threadId || !request2.messageId || !Number.isSafeInteger(offset2) || offset2 < 0)
        throw new Error(
          "Audio requires a conversation, message ID, and nonnegative byte offset."
        );
      const message = chat.msgs.getModelsArray().find((m) => key(m) === request2.messageId);
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
      if (location.origin !== "https://web.whatsapp.com" || (request2.targetId ? collections.Chat.get(request2.targetId) : collections.Chat.getActive?.()) !== chat || !chat.msgs.getModelsArray().includes(message) || message.isViewOnce)
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
    if (request2.cursor) {
      offset = messages.findIndex((m) => key(m) === request2.cursor);
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
      offset = request2.cursor ? messages.findIndex((m) => key(m) === request2.cursor) + 1 : 0;
      if (request2.cursor && !offset)
        throw new Error(
          "WhatsApp unloaded the pagination checkpoint. Start a new collection."
        );
      if (!exhausted && offset === messages.length)
        throw new Error(
          "WhatsApp did not advance its history checkpoint. Try resuming later."
        );
    }
    const current = id(
      (request2.targetId ? collections.Chat.get(request2.targetId) : collections.Chat.getActive?.())?.id
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
function getPlatform(id = "instagram") {
  const platform = Object.hasOwn(platforms, id) && platforms[id];
  if (!platform) throw new Error("Unsupported conversation platform.");
  return platform;
}

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
async function fetchHistory(session2, { request: request2, signal, progress = () => {
}, sleep = wait }) {
  const platform = getPlatform(session2.options.platform);
  while (!session2.complete) {
    signal?.throwIfAborted();
    let result;
    for (let attempt = 0; attempt < 4; attempt++) {
      result = await request2({
        kind: "messages",
        threadId: session2.options.threadId,
        cursor: session2.cursor,
        ...platform.messageRequest(session2.options)
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
    acceptPage(session2, platform.page(result));
    progress(
      `${session2.messages.length.toLocaleString()} ${platform.itemLabel || "messages"} collected \xB7 ${session2.pages} pages`
    );
    if (!session2.complete) await sleep(600, signal);
  }
}
async function transcribe(session2, { request: request2, signal, progress = () => {
}, sleep = wait }) {
  if (!getPlatform(session2.options.platform).capabilities.transcribe)
    throw new Error("Voice transcription is unavailable for this platform.");
  const audio = [
    ...new Map(
      session2.messages.flatMap((m) => m.attachments).filter((a) => a.type === "audio" && a.mediaId).map((a) => [a.mediaId, a])
    ).values()
  ];
  const cache = /* @__PURE__ */ new Map();
  for (const m of session2.messages)
    for (const [id, text] of Object.entries(m.transcripts || {}))
      cache.set(id, text);
  let done = 0;
  for (const attachment of audio) {
    signal?.throwIfAborted();
    if (!cache.has(attachment.mediaId)) {
      const result = await request2({
        kind: "transcription",
        threadId: session2.options.threadId,
        mediaId: attachment.mediaId,
        ...getPlatform(session2.options.platform).transcriptionRequest()
      });
      signal?.throwIfAborted();
      if (result.ok) cache.set(attachment.mediaId, result.transcript);
      else
        session2.warnings.push(
          `Voice message ${attachment.mediaId}: ${result.error}`
        );
      for (const message of session2.messages) {
        const texts = message.attachments.filter((a) => a.type === "audio" && cache.has(a.mediaId)).map((a) => [a.mediaId, cache.get(a.mediaId)]);
        if (texts.length) {
          message.transcripts = Object.fromEntries(texts);
          message.transcript = [...new Set(texts.map((t) => t[1]))].join("\n");
        }
      }
      await sleep(800, signal);
    }
    progress(`Transcribing voice messages: ${++done} / ${audio.length}`);
  }
  const missing = session2.messages.flatMap((m) => m.attachments).filter((a) => a.type === "audio" && !a.mediaId).length;
  if (missing)
    session2.warnings.push(
      `${missing} audio attachments have no transcription media ID.`
    );
}

// src/whatsapp-media.js
function isWhatsAppAudio(attachment) {
  return attachment.provider === "whatsapp" && attachment.type === "audio" && typeof attachment.messageId === "string" && attachment.messageId.length > 0 && attachment.url === `whatsapp:audio/${encodeURIComponent(attachment.messageId)}`;
}
async function downloadWhatsAppAudio(attachment, { request: request2, threadId, signal }) {
  if (!isWhatsAppAudio(attachment))
    throw new Error("Invalid WhatsApp audio reference.");
  const parts = [];
  let offset = 0, total, mime;
  do {
    signal?.throwIfAborted();
    const chunk = await request2({
      kind: "media",
      threadId,
      messageId: attachment.messageId,
      offset
    });
    signal?.throwIfAborted();
    if (!chunk?.ok)
      throw new Error(chunk?.error || "WhatsApp audio did not respond.");
    if (chunk.messageId !== attachment.messageId || chunk.offset !== offset || !Number.isSafeInteger(chunk.totalBytes) || chunk.totalBytes <= offset || !/^audio\/[a-z0-9.+-]+$/.test(chunk.mime) || typeof chunk.data !== "string" || chunk.data.length > 262144 || offset > 0 && (chunk.totalBytes !== total || chunk.mime !== mime))
      throw new Error("WhatsApp returned an inconsistent audio chunk.");
    total = chunk.totalBytes;
    mime = chunk.mime;
    const bytes = Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0));
    const next = offset + bytes.length;
    if (!bytes.length || next > total || chunk.nextOffset !== (next === total ? null : next))
      throw new Error("WhatsApp returned an invalid audio checkpoint.");
    parts.push(bytes);
    offset = chunk.nextOffset;
  } while (offset !== null);
  return new Blob(parts, { type: mime });
}

// src/export.js
var escapeHtml = (value) => String(value ?? "").replace(
  /[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
);
var safeName = (value) => String(value).replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 100) || "conversation";
var isSaved = (session2) => session2.options.platform === "instagram-saved";
var savedPost = ({ id, sender, timestamp, caption, url, raw }, includeRaw) => ({
  id,
  author: sender,
  caption,
  url,
  publishedAt: timestamp === null ? null : new Date(timestamp).toISOString(),
  ...includeRaw ? { raw } : {}
});
function jsonReport(session2) {
  if (isSaved(session2))
    return JSON.stringify(
      {
        schemaVersion: 1,
        platform: "instagram",
        kind: "saved-posts",
        exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
        complete: session2.complete,
        warnings: session2.warnings,
        posts: session2.messages.map(
          (post) => savedPost(post, session2.options.raw)
        )
      },
      null,
      2
    );
  return JSON.stringify(
    {
      schemaVersion: 2,
      platform: session2.options.platform || "instagram",
      threadId: session2.options.threadId,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      complete: session2.complete,
      range: { start: session2.options.start, end: session2.options.end },
      warnings: session2.warnings,
      messages: chronological(session2.messages).map(
        ({ raw, ...message }) => session2.options.raw ? { ...message, raw } : message
      )
    },
    null,
    2
  );
}
function textReport(session2) {
  if (isSaved(session2))
    return [
      "Instagram saved posts",
      session2.complete ? "Requested saved posts complete" : "PARTIAL EXPORT",
      ...session2.warnings,
      "",
      ...session2.messages.map(
        (post) => `@${post.sender} \xB7 ${post.timestamp === null ? "Publication date unavailable" : "Published " + new Date(post.timestamp).toLocaleString()}
${post.url}
${post.caption || "[No caption]"}
`
      )
    ].join("\n");
  return [
    `${getPlatform(session2.options.platform).label} conversation ${session2.options.threadId}`,
    session2.complete ? "Requested history complete" : "PARTIAL EXPORT",
    ...session2.warnings,
    "",
    ...chronological(session2.messages).map(
      (m) => `[${new Date(m.timestamp).toLocaleString()}] ${m.sender}: ${m.text}${m.transcript ? "\nTranscript: " + m.transcript : ""}${m.attachments.map((a) => "\nAttachment: " + a.url).join("")}${m.reactions?.length ? "\nReactions: " + JSON.stringify(m.reactions) : ""}`
    )
  ].join("\n");
}
function htmlReport(session2, embedded = /* @__PURE__ */ new Map(), paths = /* @__PURE__ */ new Map()) {
  const e = escapeHtml;
  const saved = isSaved(session2);
  const title = saved ? "Instagram saved posts" : `${getPlatform(session2.options.platform).label} conversation`;
  const rows = (saved ? session2.messages : chronological(session2.messages)).map((m) => {
    const media2 = m.attachments.map((a) => {
      if (isWhatsAppAudio(a)) {
        const local2 = paths.get(a.url);
        if (local2 && /^attachments\/[\w-]+\.[a-z0-9]+$/.test(local2))
          return `<div><a href="${e(local2)}" download>Download audio</a></div>`;
        return `<p>Audio ${a.status === "failed" ? "download failed" : "files are available in the ZIP when downloaded"}.</p>`;
      }
      if (!isMediaUrl(a.url)) return "";
      const data = embedded.get(a.url);
      const local = paths.get(a.url);
      const href = local || a.url;
      const image = ["image", "gif"].includes(a.type) && (data || local) ? `<img alt="Attachment from ${e(m.sender)}" src="${e(data || local)}" loading="lazy">` : "";
      return `<div>${image}<a href="${e(href)}" rel="noreferrer noopener" target="_blank">${e(a.type)} attachment${a.status === "failed" ? " (download failed)" : ""}</a></div>`;
    }).join("");
    return `<article class="${m.isMe ? "mine" : ""}"><header><strong>${e(m.sender)}</strong> <time>${e(saved && m.timestamp === null ? "Publication date unavailable" : new Date(m.timestamp).toLocaleString())}</time></header><p>${e(m.text || (saved ? "[No caption]" : ""))}</p>${saved && /^https:\/\/www\.instagram\.com\/p\/[A-Za-z0-9_-]+\/$/.test(m.url) ? `<p><a href="${e(m.url)}" rel="noreferrer noopener" target="_blank">View post on Instagram</a></p>` : ""}${m.transcript ? `<p><strong>Transcript</strong><br>${e(m.transcript)}</p>` : ""}${media2}${m.reactions?.length ? `<p class="muted">Reactions: ${e(JSON.stringify(m.reactions))}</p>` : ""}</article>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${e(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;color:#18202d;background:#f3f5f8;margin:0;padding:32px}main{max-width:820px;margin:auto}h1{font-size:26px}article{background:white;border:1px solid #cfd7e3;border-radius:12px;padding:16px;margin:16px 0;break-inside:avoid}.mine{border-left:4px solid #2757be}p{white-space:pre-wrap;overflow-wrap:anywhere}time,.muted{color:#505d70}time{font-size:13px}img{display:block;max-width:100%;max-height:600px}a{color:#174aa5;overflow-wrap:anywhere}@media print{body{background:white;padding:0}article{border-radius:0}a{color:inherit}}</style></head><body><main><h1>${e(title)}</h1><p>${saved ? "Publication dates shown where available" : "Thread " + e(session2.options.threadId)} \xB7 ${session2.messages.length} ${saved ? "posts" : "messages"} \xB7 ${session2.complete ? "Requested history complete" : "PARTIAL EXPORT"}</p>${session2.warnings.map((w) => `<p>${e(w)}</p>`).join("")}${rows}</main></body></html>`;
}

// src/media.js
async function downloadMedia(messages, { signal, progress = () => {
}, fetcher = fetch, loadWhatsAppAudio } = {}) {
  const files = /* @__PURE__ */ new Map(), paths = /* @__PURE__ */ new Map(), embedded = /* @__PURE__ */ new Map(), failures = [];
  const attachments = [
    ...new Map(
      messages.flatMap((m) => m.attachments).map((a) => [a.url, a])
    ).values()
  ];
  let index = 0, done = 0;
  async function worker() {
    while (index < attachments.length) {
      signal?.throwIfAborted();
      const i2 = index++, a = attachments[i2];
      try {
        let blob;
        if (isWhatsAppAudio(a)) {
          if (!loadWhatsAppAudio)
            throw new Error("Connect to WhatsApp to download this audio.");
          blob = await loadWhatsAppAudio(a, { signal });
        } else {
          if (!isMediaUrl(a.url))
            throw new Error("Not an allowed Meta CDN URL");
          const response = await fetcher(a.url, {
            credentials: "omit",
            redirect: "error",
            signal: AbortSignal.any([
              signal || new AbortController().signal,
              AbortSignal.timeout(25e3)
            ])
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          blob = await response.blob();
        }
        signal?.throwIfAborted();
        if (!blob.size) throw new Error("Empty attachment");
        const mime = blob.type.split(";")[0];
        const ext = {
          "image/jpeg": "jpg",
          "image/png": "png",
          "image/webp": "webp",
          "image/gif": "gif",
          "video/mp4": "mp4",
          "audio/mp4": "m4a",
          "audio/mpeg": "mp3",
          "audio/ogg": "ogg",
          "audio/webm": "webm",
          "audio/aac": "aac",
          "audio/wav": "wav",
          "audio/opus": "opus",
          "video/webm": "webm"
        }[mime] || "bin";
        const path = `attachments/${String(i2 + 1).padStart(6, "0")}-${safeName(a.type)}.${ext}`;
        files.set(path, new Uint8Array(await blob.arrayBuffer()));
        paths.set(a.url, path);
        if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime)) {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          embedded.set(a.url, dataUrl);
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        failures.push({ url: a.url, error: error.message });
      }
      progress(++done, attachments.length);
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(3, attachments.length) }, worker)
  );
  const rejected = results.find((r) => r.status === "rejected");
  if (rejected) throw rejected.reason;
  for (const message of messages)
    for (const a of message.attachments) {
      a.status = paths.has(a.url) ? "downloaded" : "failed";
      if (paths.has(a.url)) a.path = paths.get(a.url);
      else delete a.path;
    }
  return { files, paths, embedded, failures };
}

// node_modules/fflate/esm/browser.js
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i2 = 0; i2 < 31; ++i2) {
    b[i2] = start += 1 << eb[i2 - 1];
  }
  var r = new i32(b[30]);
  for (var i2 = 1; i2 < 30; ++i2) {
    for (var j = b[i2]; j < b[i2 + 1]; ++j) {
      r[j] = j - b[i2] << 5 | i2;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = (function(cd, mb, r) {
  var s = cd.length;
  var i2 = 0;
  var l = new u16(mb);
  for (; i2 < s; ++i2) {
    if (cd[i2])
      ++l[cd[i2] - 1];
  }
  var le = new u16(mb);
  for (i2 = 1; i2 < mb; ++i2) {
    le[i2] = le[i2 - 1] + l[i2 - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i2 = 0; i2 < s; ++i2) {
      if (cd[i2]) {
        var sv = i2 << 4 | cd[i2];
        var r_1 = mb - cd[i2];
        var v = le[cd[i2] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i2 = 0; i2 < s; ++i2) {
      if (cd[i2]) {
        co[i2] = rev[le[cd[i2] - 1]++] >> 15 - cd[i2];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flm = /* @__PURE__ */ hMap(flt, 9, 0);
var fdm = /* @__PURE__ */ hMap(fdt, 5, 0);
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  // determined by compression function
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var wbits = function(d, p, v) {
  v <<= p & 7;
  var o = p / 8 | 0;
  d[o] |= v;
  d[o + 1] |= v >> 8;
};
var wbits16 = function(d, p, v) {
  v <<= p & 7;
  var o = p / 8 | 0;
  d[o] |= v;
  d[o + 1] |= v >> 8;
  d[o + 2] |= v >> 16;
};
var hTree = function(d, mb) {
  var t = [];
  for (var i2 = 0; i2 < d.length; ++i2) {
    if (d[i2])
      t.push({ s: i2, f: d[i2] });
  }
  var s = t.length;
  var t2 = t.slice();
  if (!s)
    return { t: et, l: 0 };
  if (s == 1) {
    var v = new u8(t[0].s + 1);
    v[t[0].s] = 1;
    return { t: v, l: 1 };
  }
  t.sort(function(a, b) {
    return a.f - b.f;
  });
  t.push({ s: -1, f: 25001 });
  var l = t[0], r = t[1], i0 = 0, i1 = 1, i22 = 2;
  t[0] = { s: -1, f: l.f + r.f, l, r };
  while (i1 != s - 1) {
    l = t[t[i0].f < t[i22].f ? i0++ : i22++];
    r = t[i0 != i1 && t[i0].f < t[i22].f ? i0++ : i22++];
    t[i1++] = { s: -1, f: l.f + r.f, l, r };
  }
  var maxSym = t2[0].s;
  for (var i2 = 1; i2 < s; ++i2) {
    if (t2[i2].s > maxSym)
      maxSym = t2[i2].s;
  }
  var tr = new u16(maxSym + 1);
  var mbt = ln(t[i1 - 1], tr, 0);
  if (mbt > mb) {
    var i2 = 0, dt = 0;
    var lft = mbt - mb, cst = 1 << lft;
    t2.sort(function(a, b) {
      return tr[b.s] - tr[a.s] || a.f - b.f;
    });
    for (; i2 < s; ++i2) {
      var i2_1 = t2[i2].s;
      if (tr[i2_1] > mb) {
        dt += cst - (1 << mbt - tr[i2_1]);
        tr[i2_1] = mb;
      } else
        break;
    }
    dt >>= lft;
    while (dt > 0) {
      var i2_2 = t2[i2].s;
      if (tr[i2_2] < mb)
        dt -= 1 << mb - tr[i2_2]++ - 1;
      else
        ++i2;
    }
    for (; i2 >= 0 && dt; --i2) {
      var i2_3 = t2[i2].s;
      if (tr[i2_3] == mb) {
        --tr[i2_3];
        ++dt;
      }
    }
    mbt = mb;
  }
  return { t: new u8(tr), l: mbt };
};
var ln = function(n, l, d) {
  return n.s == -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
};
var lc = function(c) {
  var s = c.length;
  while (s && !c[--s])
    ;
  var cl = new u16(++s);
  var cli = 0, cln = c[0], cls = 1;
  var w = function(v) {
    cl[cli++] = v;
  };
  for (var i2 = 1; i2 <= s; ++i2) {
    if (c[i2] == cln && i2 != s)
      ++cls;
    else {
      if (!cln && cls > 2) {
        for (; cls > 138; cls -= 138)
          w(32754);
        if (cls > 2) {
          w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
          cls = 0;
        }
      } else if (cls > 3) {
        w(cln), --cls;
        for (; cls > 6; cls -= 6)
          w(8304);
        if (cls > 2)
          w(cls - 3 << 5 | 8208), cls = 0;
      }
      while (cls--)
        w(cln);
      cls = 1;
      cln = c[i2];
    }
  }
  return { c: cl.subarray(0, cli), n: s };
};
var clen = function(cf, cl) {
  var l = 0;
  for (var i2 = 0; i2 < cl.length; ++i2)
    l += cf[i2] * cl[i2];
  return l;
};
var wfblk = function(out, pos, dat) {
  var s = dat.length;
  var o = shft(pos + 2);
  out[o] = s & 255;
  out[o + 1] = s >> 8;
  out[o + 2] = out[o] ^ 255;
  out[o + 3] = out[o + 1] ^ 255;
  for (var i2 = 0; i2 < s; ++i2)
    out[o + i2 + 4] = dat[i2];
  return (o + 4 + s) * 8;
};
var wblk = function(dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
  wbits(out, p++, final);
  ++lf[256];
  var _a2 = hTree(lf, 15), dlt = _a2.t, mlb = _a2.l;
  var _b2 = hTree(df, 15), ddt = _b2.t, mdb = _b2.l;
  var _c = lc(dlt), lclt = _c.c, nlc = _c.n;
  var _d = lc(ddt), lcdt = _d.c, ndc = _d.n;
  var lcfreq = new u16(19);
  for (var i2 = 0; i2 < lclt.length; ++i2)
    ++lcfreq[lclt[i2] & 31];
  for (var i2 = 0; i2 < lcdt.length; ++i2)
    ++lcfreq[lcdt[i2] & 31];
  var _e = hTree(lcfreq, 7), lct = _e.t, mlcb = _e.l;
  var nlcc = 19;
  for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc)
    ;
  var flen = bl + 5 << 3;
  var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
  var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
  if (bs >= 0 && flen <= ftlen && flen <= dtlen)
    return wfblk(out, p, dat.subarray(bs, bs + bl));
  var lm, ll, dm, dl;
  wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
  if (dtlen < ftlen) {
    lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
    var llm = hMap(lct, mlcb, 0);
    wbits(out, p, nlc - 257);
    wbits(out, p + 5, ndc - 1);
    wbits(out, p + 10, nlcc - 4);
    p += 14;
    for (var i2 = 0; i2 < nlcc; ++i2)
      wbits(out, p + 3 * i2, lct[clim[i2]]);
    p += 3 * nlcc;
    var lcts = [lclt, lcdt];
    for (var it = 0; it < 2; ++it) {
      var clct = lcts[it];
      for (var i2 = 0; i2 < clct.length; ++i2) {
        var len = clct[i2] & 31;
        wbits(out, p, llm[len]), p += lct[len];
        if (len > 15)
          wbits(out, p, clct[i2] >> 5 & 127), p += clct[i2] >> 12;
      }
    }
  } else {
    lm = flm, ll = flt, dm = fdm, dl = fdt;
  }
  for (var i2 = 0; i2 < li; ++i2) {
    var sym = syms[i2];
    if (sym > 255) {
      var len = sym >> 18 & 31;
      wbits16(out, p, lm[len + 257]), p += ll[len + 257];
      if (len > 7)
        wbits(out, p, sym >> 23 & 31), p += fleb[len];
      var dst = sym & 31;
      wbits16(out, p, dm[dst]), p += dl[dst];
      if (dst > 3)
        wbits16(out, p, sym >> 5 & 8191), p += fdeb[dst];
    } else {
      wbits16(out, p, lm[sym]), p += ll[sym];
    }
  }
  wbits16(out, p, lm[256]);
  return p + ll[256];
};
var deo = /* @__PURE__ */ new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);
var et = /* @__PURE__ */ new u8(0);
var dflt = function(dat, lvl, plvl, pre, post, st) {
  var s = st.z || dat.length;
  var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7e3)) + post);
  var w = o.subarray(pre, o.length - post);
  var lst = st.l;
  var pos = (st.r || 0) & 7;
  if (lvl) {
    if (pos)
      w[0] = st.r >> 3;
    var opt = deo[lvl - 1];
    var n = opt >> 13, c = opt & 8191;
    var msk_1 = (1 << plvl) - 1;
    var prev = st.p || new u16(32768), head = st.h || new u16(msk_1 + 1);
    var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
    var hsh = function(i3) {
      return (dat[i3] ^ dat[i3 + 1] << bs1_1 ^ dat[i3 + 2] << bs2_1) & msk_1;
    };
    var syms = new i32(25e3);
    var lf = new u16(288), df = new u16(32);
    var lc_1 = 0, eb = 0, i2 = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
    for (; i2 + 2 < s; ++i2) {
      var hv = hsh(i2);
      var imod = i2 & 32767, pimod = head[hv];
      prev[imod] = pimod;
      head[hv] = imod;
      if (wi <= i2) {
        var rem = s - i2;
        if ((lc_1 > 7e3 || li > 24576) && (rem > 423 || !lst)) {
          pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i2 - bs, pos);
          li = lc_1 = eb = 0, bs = i2;
          for (var j = 0; j < 286; ++j)
            lf[j] = 0;
          for (var j = 0; j < 30; ++j)
            df[j] = 0;
        }
        var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
        if (rem > 2 && hv == hsh(i2 - dif)) {
          var maxn = Math.min(n, rem) - 1;
          var maxd = Math.min(32767, i2);
          var ml = Math.min(258, rem);
          while (dif <= maxd && --ch_1 && imod != pimod) {
            if (dat[i2 + l] == dat[i2 + l - dif]) {
              var nl = 0;
              for (; nl < ml && dat[i2 + nl] == dat[i2 + nl - dif]; ++nl)
                ;
              if (nl > l) {
                l = nl, d = dif;
                if (nl > maxn)
                  break;
                var mmd = Math.min(dif, nl - 2);
                var md = 0;
                for (var j = 0; j < mmd; ++j) {
                  var ti = i2 - dif + j & 32767;
                  var pti = prev[ti];
                  var cd = ti - pti & 32767;
                  if (cd > md)
                    md = cd, pimod = ti;
                }
              }
            }
            imod = pimod, pimod = prev[imod];
            dif += imod - pimod & 32767;
          }
        }
        if (d) {
          syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
          var lin = revfl[l] & 31, din = revfd[d] & 31;
          eb += fleb[lin] + fdeb[din];
          ++lf[257 + lin];
          ++df[din];
          wi = i2 + l;
          ++lc_1;
        } else {
          syms[li++] = dat[i2];
          ++lf[dat[i2]];
        }
      }
    }
    for (i2 = Math.max(i2, wi); i2 < s; ++i2) {
      syms[li++] = dat[i2];
      ++lf[dat[i2]];
    }
    pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i2 - bs, pos);
    if (!lst) {
      st.r = pos & 7 | w[pos / 8 | 0] << 3;
      pos -= 7;
      st.h = head, st.p = prev, st.i = i2, st.w = wi;
    }
  } else {
    for (var i2 = st.w || 0; i2 < s + lst; i2 += 65535) {
      var e = i2 + 65535;
      if (e >= s) {
        w[pos / 8 | 0] = lst;
        e = s;
      }
      pos = wfblk(w, pos + 1, dat.subarray(i2, e));
    }
    st.i = s;
  }
  return slc(o, 0, pre + shft(pos) + post);
};
var crct = /* @__PURE__ */ (function() {
  var t = new Int32Array(256);
  for (var i2 = 0; i2 < 256; ++i2) {
    var c = i2, k = 9;
    while (--k)
      c = (c & 1 && -306674912) ^ c >>> 1;
    t[i2] = c;
  }
  return t;
})();
var crc = function() {
  var c = -1;
  return {
    p: function(d) {
      var cr = c;
      for (var i2 = 0; i2 < d.length; ++i2)
        cr = crct[cr & 255 ^ d[i2]] ^ cr >>> 8;
      c = cr;
    },
    d: function() {
      return ~c;
    }
  };
};
var dopt = function(dat, opt, pre, post, st) {
  if (!st) {
    st = { l: 1 };
    if (opt.dictionary) {
      var dict = opt.dictionary.subarray(-32768);
      var newDat = new u8(dict.length + dat.length);
      newDat.set(dict);
      newDat.set(dat, dict.length);
      dat = newDat;
      st.w = dict.length;
    }
  }
  return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20 : 12 + opt.mem, pre, post, st);
};
var mrg = function(a, b) {
  var o = {};
  for (var k in a)
    o[k] = a[k];
  for (var k in b)
    o[k] = b[k];
  return o;
};
var wbytes = function(d, b, v) {
  for (; v; ++b)
    d[b] = v, v >>>= 8;
};
function deflateSync(data, opts) {
  return dopt(data, opts || {}, 0, 0);
}
var fltn = function(d, p, t, o) {
  for (var k in d) {
    var val = d[k], n = p + k, op = o;
    if (Array.isArray(val))
      op = mrg(o, val[1]), val = val[0];
    if (ArrayBuffer.isView(val))
      t[n] = [val, op];
    else {
      t[n += "/"] = [new u8(0), op];
      fltn(val, n, t, o);
    }
  }
};
var te = typeof TextEncoder != "undefined" && /* @__PURE__ */ new TextEncoder();
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}
function strToU8(str, latin1) {
  if (latin1) {
    var ar_1 = new u8(str.length);
    for (var i2 = 0; i2 < str.length; ++i2)
      ar_1[i2] = str.charCodeAt(i2);
    return ar_1;
  }
  if (te)
    return te.encode(str);
  var l = str.length;
  var ar = new u8(str.length + (str.length >> 1));
  var ai = 0;
  var w = function(v) {
    ar[ai++] = v;
  };
  for (var i2 = 0; i2 < l; ++i2) {
    if (ai + 5 > ar.length) {
      var n = new u8(ai + 8 + (l - i2 << 1));
      n.set(ar);
      ar = n;
    }
    var c = str.charCodeAt(i2);
    if (c < 128 || latin1)
      w(c);
    else if (c < 2048)
      w(192 | c >> 6), w(128 | c & 63);
    else if (c > 55295 && c < 57344)
      c = 65536 + (c & 1023 << 10) | str.charCodeAt(++i2) & 1023, w(240 | c >> 18), w(128 | c >> 12 & 63), w(128 | c >> 6 & 63), w(128 | c & 63);
    else
      w(224 | c >> 12), w(128 | c >> 6 & 63), w(128 | c & 63);
  }
  return slc(ar, 0, ai);
}
var exfl = function(ex) {
  var le = 0;
  if (ex) {
    for (var k in ex) {
      var l = ex[k].length;
      if (l > 65535)
        err(9);
      le += l + 4;
    }
  }
  return le;
};
var wzh = function(d, b, f, fn, u, c, ce, co) {
  var fl2 = fn.length, ex = f.extra, col = co && co.length;
  var exl = exfl(ex);
  wbytes(d, b, ce != null ? 33639248 : 67324752), b += 4;
  if (ce != null)
    d[b++] = 20, d[b++] = f.os;
  d[b] = 20, b += 2;
  d[b++] = f.flag << 1 | (c < 0 && 8), d[b++] = u && 8;
  d[b++] = f.compression & 255, d[b++] = f.compression >> 8;
  var dt = new Date(f.mtime == null ? Date.now() : f.mtime), y = dt.getFullYear() - 1980;
  if (y < 0 || y > 119)
    err(10);
  wbytes(d, b, y << 25 | dt.getMonth() + 1 << 21 | dt.getDate() << 16 | dt.getHours() << 11 | dt.getMinutes() << 5 | dt.getSeconds() >> 1), b += 4;
  if (c != -1) {
    wbytes(d, b, f.crc);
    wbytes(d, b + 4, c < 0 ? -c - 2 : c);
    wbytes(d, b + 8, f.size);
  }
  wbytes(d, b + 12, fl2);
  wbytes(d, b + 14, exl), b += 16;
  if (ce != null) {
    wbytes(d, b, col);
    wbytes(d, b + 6, f.attrs);
    wbytes(d, b + 10, ce), b += 14;
  }
  d.set(fn, b);
  b += fl2;
  if (exl) {
    for (var k in ex) {
      var exf = ex[k], l = exf.length;
      wbytes(d, b, +k);
      wbytes(d, b + 2, l);
      d.set(exf, b + 4), b += 4 + l;
    }
  }
  if (col)
    d.set(co, b), b += col;
  return b;
};
var wzf = function(o, b, c, d, e) {
  wbytes(o, b, 101010256);
  wbytes(o, b + 8, c);
  wbytes(o, b + 10, c);
  wbytes(o, b + 12, d);
  wbytes(o, b + 16, e);
};
function zipSync(data, opts) {
  if (!opts)
    opts = {};
  var r = {};
  var files = [];
  fltn(data, "", r, opts);
  var o = 0;
  var tot = 0;
  for (var fn in r) {
    var _a2 = r[fn], file = _a2[0], p = _a2[1];
    var compression = p.level == 0 ? 0 : 8;
    var f = strToU8(fn), s = f.length;
    var com = p.comment, m = com && strToU8(com), ms = m && m.length;
    var exl = exfl(p.extra);
    if (s > 65535)
      err(11);
    var d = compression ? deflateSync(file, p) : file, l = d.length;
    var c = crc();
    c.p(file);
    files.push(mrg(p, {
      size: file.length,
      crc: c.d(),
      c: d,
      f,
      m,
      u: s != fn.length || m && com.length != ms,
      o,
      compression
    }));
    o += 30 + s + exl + l;
    tot += 76 + 2 * (s + exl) + (ms || 0) + l;
  }
  var out = new u8(tot + 22), oe = o, cdl = tot - o;
  for (var i2 = 0; i2 < files.length; ++i2) {
    var f = files[i2];
    wzh(out, f.o, f, f.f, f.u, f.c.length);
    var badd = 30 + f.f.length + exfl(f.extra);
    out.set(f.c, f.o + badd);
    wzh(out, o, f, f.f, f.u, f.c.length, f.o, f.m), o += 16 + badd + (f.m ? f.m.length : 0);
  }
  wzf(out, o, files.length, cdl, oe);
  return out;
}

// src/app.js
var $ = (id) => document.getElementById(id);
var tabId = Number(new URLSearchParams(location.search).get("tab"));
var context;
var session;
var controller;
var busy = false;
var media = null;
var mediaComplete = false;
var transcriptionComplete = false;
var savedPosts = () => (session?.options.platform || context?.platform) === "instagram-saved";
var itemLabel = () => savedPosts() ? "posts" : "messages";
var report = (text) => {
  $("progress").textContent = text;
  $("count").textContent = `${session?.messages.length.toLocaleString() || 0} ${itemLabel()}`;
};
var fail = (error) => {
  $("error").textContent = error.message || String(error);
  $("error").hidden = false;
};
var request = (body) => chrome.runtime.sendMessage({
  type: "platform",
  platform: context?.platform,
  tabId,
  request: body
});
function refreshControls() {
  $("count").textContent = `${session?.messages.length.toLocaleString() || 0} ${itemLabel()}`;
  $("settings").disabled = busy;
  $("start").disabled = busy || !context;
  $("start").textContent = session ? "Start new collection" : context?.platform === "instagram-saved" ? "Collect saved posts" : "Collect conversation";
  $("pause").hidden = !busy;
  $("resume").hidden = busy || !session || session.complete && (!session.options.media || mediaComplete) && (!session.options.transcribe || transcriptionComplete);
  $("reconnect").disabled = busy;
  for (const id of ["json", "txt", "html", "pdf", "zip"])
    $(id).disabled = busy || !session?.messages.length;
  $("warnings").replaceChildren(
    ...(session?.warnings || []).map((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      return li;
    })
  );
}
async function connect() {
  $("error").hidden = true;
  try {
    const result = await request({ kind: "context" });
    if (!result?.ok)
      throw new Error(result?.error || "Could not connect to the source tab.");
    context = result;
    const platform = getPlatform(result.platform);
    for (const capability of ["media", "transcribe", "queryId"]) {
      const id = capability === "queryId" ? "query-id" : capability;
      $(id).disabled = !platform.capabilities[capability];
      $(id).closest(capability === "queryId" ? "details" : "label").hidden = !platform.capabilities[capability];
    }
    const saved = result.platform === "instagram-saved";
    $("media-label").textContent = result.platform === "whatsapp" ? "Download voice notes and audio" : "Download attachments";
    $("media-hint").textContent = result.platform === "whatsapp" ? "Audio files are included in the ZIP. Other media is not downloaded." : "Include images in HTML and PDF, and media files in a ZIP.";
    for (const id of ["from", "to"]) {
      $(id).disabled = saved;
      $(id).closest("label").hidden = saved;
    }
    $("limit-label").textContent = saved ? "Posts" : "Latest messages";
    $("limit").placeholder = saved ? "All saved posts" : "All messages";
    $("range-note").textContent = saved ? "Leave the limit blank for all available saved posts. Posts follow Instagram\u2019s saved-feed order." : "Dates use your local timezone. Leave these fields blank for all available history.";
    $("platform-note").textContent = (result.warnings || []).join(" ");
    $("source").textContent = `Connected \xB7 ${platform.label} \xB7 ${result.title || result.threadId}`;
  } catch (error) {
    context = null;
    $("source").textContent = "No source connected";
    fail(error);
  }
  refreshControls();
}
async function collect() {
  if (busy || !session) return;
  busy = true;
  controller = new AbortController();
  $("error").hidden = true;
  refreshControls();
  const signal = controller.signal;
  try {
    await fetchHistory(session, { request, signal, progress: report });
    if (session.options.transcribe && !transcriptionComplete) {
      await transcribe(session, { request, signal, progress: report });
      transcriptionComplete = true;
    }
    if (session.options.media && !mediaComplete) {
      report("Downloading attachments\u2026");
      media = await downloadMedia(session.messages, {
        signal,
        loadWhatsAppAudio: (attachment, options) => downloadWhatsAppAudio(attachment, {
          ...options,
          request,
          threadId: session.options.threadId
        }),
        progress: (done, total) => report(`Attachments: ${done} / ${total}`)
      });
      mediaComplete = true;
      if (media.failures.length)
        session.warnings.push(
          `${media.failures.length} attachments could not be downloaded. Message history is retained; details are in the ZIP's attachment-errors.json.`
        );
    }
    report(
      session.messages.length ? `Collection complete. ${session.messages.length.toLocaleString()} ${itemLabel()} ready to save.` : `No ${itemLabel()} found.`
    );
  } catch (error) {
    report(
      signal.aborted ? "Paused. Save a partial archive or resume." : "Collection stopped. Your collected items are still available."
    );
    if (!signal.aborted) fail(error);
  } finally {
    busy = false;
    refreshControls();
  }
}
$("export-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (!context || busy) return;
    if (session?.messages.length && !confirm(
      "Start over? Save the current archive first if you want to keep it."
    ))
      return;
    const limit = $("limit").value ? Number($("limit").value) : null;
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1))
      throw new Error(
        "The limit must be a positive whole number, or blank for all available items."
      );
    const range = context.platform === "instagram-saved" ? { start: null, end: null } : parseDateRange($("from").value, $("to").value);
    const options = {
      ...range,
      limit,
      platform: context.platform || "instagram",
      threadId: context.threadId,
      queryId: $("query-id").value,
      media: !$("media").disabled && $("media").checked,
      transcribe: !$("transcribe").disabled && $("transcribe").checked,
      raw: $("raw").checked
    };
    await chrome.storage.local.set({
      preferences: {
        queryId: options.queryId,
        media: options.media,
        transcribe: options.transcribe,
        raw: options.raw
      }
    });
    session = createSession(options);
    session.warnings.push(...context.warnings || []);
    media = null;
    mediaComplete = false;
    transcriptionComplete = false;
    await collect();
  } catch (error) {
    fail(error);
  }
});
$("resume").addEventListener("click", collect);
$("pause").addEventListener("click", () => {
  controller?.abort(new DOMException("Paused", "AbortError"));
  report("Pausing after the current request\u2026");
});
$("reconnect").addEventListener("click", connect);
window.addEventListener("beforeunload", (event) => {
  if (busy) {
    event.preventDefault();
    event.returnValue = "";
  }
});
function download(data, type, extension) {
  const blob = new Blob([data], { type }), url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url;
  a.download = `${session.options.platform}-${safeName(session.options.threadId)}-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}${session.complete ? "" : "-partial"}.${extension}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 6e4);
}
$("json").addEventListener(
  "click",
  () => download(jsonReport(session), "application/json", "json")
);
$("txt").addEventListener(
  "click",
  () => download(textReport(session), "text/plain;charset=utf-8", "txt")
);
$("html").addEventListener(
  "click",
  () => download(
    htmlReport(session, media?.embedded),
    "text/html;charset=utf-8",
    "html"
  )
);
$("zip").addEventListener("click", () => {
  try {
    const files = Object.fromEntries(media?.files || []);
    const name = savedPosts() ? "saved-posts" : "conversation";
    files[`${name}.json`] = strToU8(jsonReport(session));
    files[`${name}.txt`] = strToU8(textReport(session));
    files[`${name}.html`] = strToU8(
      htmlReport(session, /* @__PURE__ */ new Map(), media?.paths)
    );
    files["attachment-errors.json"] = strToU8(
      JSON.stringify(media?.failures || [], null, 2)
    );
    download(zipSync(files, { level: 0 }), "application/zip", "zip");
  } catch (error) {
    fail(error);
  }
});
$("pdf").addEventListener("click", () => {
  $("print").disabled = true;
  $("report").srcdoc = htmlReport(session, media?.embedded);
  $("preview").showModal();
});
$("report").addEventListener("load", () => {
  $("print").disabled = false;
});
$("print").addEventListener("click", () => {
  $("report").contentWindow.focus();
  $("report").contentWindow.print();
});
$("close-preview").addEventListener("click", () => $("preview").close());
async function boot() {
  try {
    const { preferences = {} } = await chrome.storage.local.get("preferences");
    for (const key of ["media", "transcribe", "raw"])
      if (key in preferences) $(key).checked = Boolean(preferences[key]);
    if (/^\d+$/.test(preferences.queryId))
      $("query-id").value = preferences.queryId;
    await connect();
  } catch (error) {
    fail(error);
  }
}
boot();
