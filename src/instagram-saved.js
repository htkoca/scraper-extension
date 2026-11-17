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
          "Captions and post links only. Unavailable publication dates are left unknown. Posts without captions are retained.",
        ],
      };
    const graphql = async (friendly, fallbackId, variables) => {
      const scripts = Array.from(
        document.scripts || [],
        (script) => script.textContent || "",
      ).join("\n");
      const token = (name) => {
        try {
          const value = window.require?.(name)?.token;
          if (value) return value;
        } catch {}
        return scripts.match(
          new RegExp(
            '"' +
              name +
              '"\\s*,\\s*\\[\\]\\s*,\\s*\\{\\s*"token"\\s*:\\s*"([^"\\n]+)"',
          ),
        )?.[1];
      };
      const dtsg = token("DTSGInitialData"),
        lsd = token("LSD");
      if (!dtsg || !lsd)
        throw new Error(
          "Instagram authentication is still loading. Refresh the selected tab and retry.",
        );
      let queryId = fallbackId;
      try {
        queryId =
          window.require?.(friendly + ".graphql")?.params?.id || fallbackId;
      } catch {}
      const response = await fetch("/api/graphql", {
        method: "POST",
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.timeout(25000),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-CSRFToken": csrf,
          "X-FB-Friendly-Name": friendly,
          "X-FB-LSD": lsd,
          "X-IG-App-ID": "936619743392459",
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
          variables: JSON.stringify(variables),
        }).toString(),
      });
      if (!response.ok)
        return {
          ok: false,
          status: response.status,
          retryAfter: response.headers.get("Retry-After"),
          error: `Instagram source-tab request returned HTTP ${response.status}.`,
        };
      const body = await response.json();
      if (body.errors?.length || !body.data)
        throw new Error(
          "Instagram did not return the requested saved collection data.",
        );
      return { ok: true, data: body.data };
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
            "AUDIO_AUTO_COLLECTION",
          ],
          first: 12,
          ...(request.cursor ? { after: request.cursor } : {}),
        },
      );
      if (!result.ok) return result;
      const connection =
        result.data.viewer?.collections_unified_with_auto_collections;
      if (
        !Array.isArray(connection?.edges) ||
        typeof connection.page_info?.has_next_page !== "boolean"
      )
        throw new Error("Instagram returned an unsupported collection list.");
      const collections = connection.edges
        .map(({ node }) => node)
        .filter(
          (node) =>
            !/^(?:IG|XDT)?(?:AllMedia|Audio|Playlist)AutoCollection$/.test(
              node?.__typename || "",
            ),
        )
        .map((node) => {
          if (
            !node ||
            !/^\d+$/.test(String(node.collection_id || node.id || "")) ||
            typeof node.collection_name !== "string"
          )
            throw new Error("A collection is missing its name or numeric ID.");
          return {
            id: String(node.collection_id || node.id),
            name: node.collection_name,
            count: Number.isSafeInteger(node.collection_media_count)
              ? node.collection_media_count
              : null,
          };
        });
      const nextCursor = connection.page_info.has_next_page
        ? connection.page_info.end_cursor
        : null;
      if (
        connection.page_info.has_next_page &&
        (!nextCursor || nextCursor === request.cursor)
      )
        throw new Error("Instagram repeated a collection cursor.");
      return { ok: true, collections, nextCursor, transport: "source-tab" };
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
          __relay_internal__pv__PolarisSEOIsCrawlerrelayprovider: false,
        },
      );
      if (!result.ok) return result;
      const collection = result.data.fetch__MediaCollection,
        media = collection?.media;
      if (
        String(collection?.id) !== collectionId ||
        !Array.isArray(media?.edges) ||
        typeof media.page_info?.has_next_page !== "boolean"
      )
        throw new Error("Instagram saved collection contents changed.");
      body = {
        status: "ok",
        items: media.edges.map(({ node }) => node),
        more_available: media.page_info.has_next_page,
        next_max_id: media.page_info.end_cursor,
      };
    } else {
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
      try {
        body = await response.json();
      } catch {
        throw new Error(
          "Instagram returned a non-JSON response. Check your login or account prompts.",
        );
      }
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
        (!(collectionId && post.taken_at === undefined) &&
          (!Number.isFinite(post.taken_at) || post.taken_at < 0)) ||
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
        timestamp: Number.isFinite(post.taken_at) ? post.taken_at * 1000 : null,
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
