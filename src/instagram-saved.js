// Chrome serializes this function into the signed-in Instagram tab.
export async function instagramSavedRequest(request) {
  try {
    if (
      location.origin !== "https://www.instagram.com" ||
      !/^\/[^/]+\/saved(?:\/all-posts|\/(?:[^/]+\/)?\d+)?\/?$/.test(
        location.pathname,
      )
    )
      throw new Error("Open your Instagram Saved page (All posts) first.");
    const cookie = (name) =>
      document.cookie
        .split(/;\s*/)
        .find((c) => c.startsWith(name + "="))
        ?.slice(name.length + 1);
    const viewerId = cookie("ds_user_id");
    const csrf = cookie("csrftoken");
    if (!viewerId || !csrf)
      throw new Error(
        "Sign in to Instagram, reload the Saved page, and try again.",
      );
    const segments = location.pathname.split("/").filter(Boolean);
    const selected = segments[2];
    // Collection URLs use /user/saved/name/id/; All posts has no ID.
    const pathCollection =
      selected && selected !== "all-posts" ? segments.at(-1) : null;
    const collectionId = request.collectionId || pathCollection;
    if (collectionId && !/^\d+$/.test(collectionId))
      throw new Error(
        "This saved collection URL has no numeric collection ID. Open the collection itself.",
      );
    const threadId = collectionId
      ? `saved-${viewerId}-${collectionId}`
      : `saved-${viewerId}`;
    if (request.threadId && request.threadId !== threadId)
      throw new Error(
        "The Instagram account changed or the selected collection changed. Return to the original source to resume.",
      );
    if (request.kind === "context")
      return {
        ok: true,
        threadId,
        title: collectionId
          ? `Saved collection ${collectionId}`
          : "Saved posts",
        collectionId: collectionId || null,
        warnings: [
          "Captions and post links only. Dates are publication dates, not dates saved. Posts without captions are retained.",
        ],
      };
    if (request.kind === "collections") {
      const params = new URLSearchParams({
        collection_types: '["ALL_MEDIA_AUTO_COLLECTION","MEDIA"]',
      });
      if (request.cursor) params.set("max_id", request.cursor);
      const response = await fetch("/api/v1/collections/list/?" + params, {
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.timeout(25000),
        headers: { "X-CSRFToken": csrf, "X-IG-App-ID": "936619743392459" },
      });
      if (!response.ok)
        throw new Error(
          `Instagram returned HTTP ${response.status} while listing collections.`,
        );
      const body = await response.json();
      if (body.status !== "ok" || !Array.isArray(body.items))
        throw new Error("Instagram returned an unsupported collection list.");
      const collections = body.items
        .map((item) => ({
          id: String(item.collection_id || item.id || ""),
          name: item.collection_name || item.name,
          count: Number.isSafeInteger(item.collection_media_count)
            ? item.collection_media_count
            : null,
        }))
        .filter(
          (item) => /^\d+$/.test(item.id) && typeof item.name === "string",
        );
      if (collections.length !== body.items.length)
        throw new Error("A collection is missing its name or numeric ID.");
      const nextCursor = body.more_available
        ? body.next_max_id || body.max_id
        : null;
      if (body.more_available && (!nextCursor || nextCursor === request.cursor))
        throw new Error("Instagram repeated a collection cursor.");
      return { ok: true, collections, nextCursor: nextCursor || null };
    }
    if (request.kind !== "messages")
      throw new Error("Unsupported saved-post request.");
    const params = new URLSearchParams({
      count: "30",
      include_igtv_preview: "false",
    });
    if (request.cursor) params.set("max_id", request.cursor);
    const endpoint = collectionId
      ? `/api/v1/feed/collection/${collectionId}/`
      : "/api/v1/feed/saved/posts/";
    const response = await fetch(endpoint + "?" + params, {
      credentials: "include",
      redirect: "error",
      signal: AbortSignal.timeout(25000),
      headers: { "X-CSRFToken": csrf, "X-IG-App-ID": "936619743392459" },
    });
    if (!response.ok)
      return {
        ok: false,
        status: response.status,
        retryAfter: response.headers.get("Retry-After"),
        error: `Instagram returned HTTP ${response.status} while loading saved posts.`,
      };
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(
        "Instagram returned a non-JSON response. Check your login or account prompts.",
      );
    }
    if (
      body.status !== "ok" ||
      !Array.isArray(body.items) ||
      typeof body.more_available !== "boolean"
    )
      throw new Error(
        "Instagram did not return a supported saved-post page. Reload Instagram and try again.",
      );
    const messages = body.items.map((item) => {
      const post = item.media || item;
      const id = String(post.pk || post.id || "");
      if (
        !id ||
        !/^[A-Za-z0-9_-]+$/.test(post.code || "") ||
        !Number.isFinite(post.taken_at) ||
        post.taken_at < 0 ||
        (post.caption != null && typeof post.caption.text !== "string")
      )
        throw new Error(
          "A saved post has unsupported caption or metadata fields. Collection paused.",
        );
      const caption = post.caption?.text || "";
      const url = `https://www.instagram.com/p/${post.code}/`;
      const author = post.user?.username || "Unknown author";
      return {
        id,
        timestamp: post.taken_at * 1000,
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
          media_type: post.media_type,
        },
      };
    });
    return {
      ok: true,
      page: {
        messages,
        hasMore: body.more_available,
        nextCursor: body.next_max_id || null,
      },
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}
