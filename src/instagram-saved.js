// Chrome serializes this function into the signed-in Instagram tab.
export async function instagramSavedRequest(request) {
  try {
    if (
      location.origin !== "https://www.instagram.com" ||
      !/^\/[^/]+\/saved(?:\/all-posts)?\/?$/.test(location.pathname)
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
    const threadId = `saved-${viewerId}`;
    if (request.threadId && request.threadId !== threadId)
      throw new Error(
        "The Instagram account changed. Return to the original account to resume.",
      );
    if (request.kind === "context")
      return {
        ok: true,
        threadId,
        title: "Saved posts",
        warnings: [
          "Captions and post links only. Dates are publication dates, not dates saved. Posts without captions are retained.",
        ],
      };
    if (request.kind !== "messages")
      throw new Error("Unsupported saved-post request.");
    const params = new URLSearchParams({
      count: "30",
      include_igtv_preview: "false",
    });
    if (request.cursor) params.set("max_id", request.cursor);
    const response = await fetch("/api/v1/feed/saved/posts/?" + params, {
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
