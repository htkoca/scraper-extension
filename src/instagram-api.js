// Only nonsecret account metadata leaves this page function.
export function instagramAccountContext() {
  try {
    if (location.origin !== "https://www.instagram.com")
      throw new Error("Open a signed-in Instagram tab first.");
    const viewerId = document.cookie
      .split(/;\s*/)
      .find((c) => c.startsWith("ds_user_id="))
      ?.slice(11);
    if (!viewerId)
      throw new Error("Sign in to Instagram in the selected browser tab.");
    const ownProfile = [...document.querySelectorAll("a[href]")].find(
      (link) => {
        const path = new URL(link.href, location.origin).pathname;
        return (
          /^\/[A-Za-z0-9._]+\/$/.test(path) &&
          /profile/i.test(
            (link.getAttribute("aria-label") || "") +
              (link.querySelector("img")?.getAttribute("alt") || "") +
              link.textContent,
          )
        );
      },
    );
    const username =
      ownProfile &&
      new URL(ownProfile.href, location.origin).pathname.split("/")[1];
    return { ok: true, viewerId, username };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// Serialized into the selected signed-in tab. Tokens and requests never leave that context.
export async function instagramGraphqlRequest({
  friendly,
  fallbackId,
  variables,
}) {
  try {
    if (location.origin !== "https://www.instagram.com")
      throw new Error("Open a signed-in Instagram tab first.");
    const scripts = [...document.scripts]
      .map((s) => s.textContent || "")
      .join("\n");
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
    const cookie = (name) =>
      document.cookie
        .split(/;\s*/)
        .find((c) => c.startsWith(name + "="))
        ?.slice(name.length + 1);
    const csrf = cookie("csrftoken"),
      viewerId = cookie("ds_user_id"),
      dtsg = token("DTSGInitialData"),
      lsd = token("LSD");
    if (!csrf || !viewerId || !dtsg || !lsd)
      throw new Error(
        "Instagram authentication is still loading or requires sign-in. Refresh this tab and retry.",
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
    const body = JSON.parse(
      (await response.text()).replace(/^for \(;;\);/, ""),
    );
    if (body.errors?.length)
      throw new Error(
        "Instagram GraphQL: " +
          body.errors.map((e) => e.message || "Unknown error").join("; "),
      );
    if (!body.data)
      throw new Error(
        `Instagram source-tab request returned no GraphQL data${typeof body.error === "number" ? " (code " + body.error + ")" : ""}.`,
      );
    const ownProfile = [...document.querySelectorAll("a[href]")].find(
      (link) => {
        const path = new URL(link.href, location.origin).pathname;
        return (
          /^\/[A-Za-z0-9._]+\/$/.test(path) &&
          /profile/i.test(
            (link.getAttribute("aria-label") || "") +
              (link.querySelector("img")?.getAttribute("alt") || "") +
              link.textContent,
          )
        );
      },
    );
    const username =
      ownProfile &&
      new URL(ownProfile.href, location.origin).pathname.split("/")[1];
    return {
      ok: true,
      data: body.data,
      viewerId,
      username,
      transport: "source-tab",
      warnings: [],
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export class InstagramApi {
  constructor({ execute }) {
    this.execute = execute;
  }
  async graphql(tabId, friendly, fallbackId, variables) {
    return this.execute(
      tabId,
      instagramGraphqlRequest,
      { friendly, fallbackId, variables },
      true,
    );
  }
  async discover(tabId, cursor) {
    const friendly = "PolarisProfileSavedTabContentQuery";
    const result = await this.graphql(tabId, friendly, "27584326974521636", {
      collection_types: [
        "ALL_MEDIA_AUTO_COLLECTION",
        "PLAYLIST_AUTO_COLLECTION",
        "MEDIA",
        "AUDIO_AUTO_COLLECTION",
      ],
      first: 12,
      ...(cursor ? { after: cursor } : {}),
    });
    if (!result.ok)
      throw new Error(result.error || "Instagram collection discovery failed.");
    const connection =
      result.data?.viewer?.collections_unified_with_auto_collections;
    if (
      !Array.isArray(connection?.edges) ||
      typeof connection.page_info?.has_next_page !== "boolean"
    )
      throw new Error(
        "Instagram Saved collection response changed (transport=" +
          result.transport +
          "; data=" +
          Object.keys(result.data || {}).join(",") +
          "; viewer=" +
          Object.keys(result.data?.viewer || {}).join(",") +
          "). No complete discovery was reported.",
      );
    if (!result.username)
      throw new Error(
        "Could not identify the signed-in Instagram profile from its navigation. Open your profile once, then retry.",
      );
    const nodes = connection.edges
      .map(({ node }) => node)
      .filter((node) => {
        if (
          /^(?:IG|XDT)?(?:AllMedia|Audio|Playlist)AutoCollection$/.test(
            node?.__typename || "",
          )
        )
          return false;
        if (
          !node ||
          !/^\d+$/.test(String(node.collection_id || node.id || "")) ||
          typeof node.collection_name !== "string"
        )
          throw new Error(
            "Instagram unsupported collection (type=" +
              node?.__typename +
              "; fields=" +
              Object.keys(node || {}).join(",") +
              "; transport=" +
              result.transport +
              "; " +
              (result.warnings || []).join(" ") +
              ").",
          );
        return true;
      });
    const candidates = nodes
      .map((node) => ({
        id: String(node.collection_id || node.id || ""),
        name: node.collection_name,
        count: node.collection_media_count,
        url: `https://www.instagram.com/${result.username}/saved/collection/${node.collection_id || node.id}/`,
      }))
      .filter((item) => /^\d+$/.test(item.id) && typeof item.name === "string");
    const nextCursor = connection.page_info.has_next_page
      ? connection.page_info.end_cursor
      : null;
    if (
      connection.page_info.has_next_page &&
      (!nextCursor || nextCursor === cursor)
    )
      throw new Error(
        "Instagram collection discovery did not advance its cursor.",
      );
    return {
      ok: true,
      candidates,
      nextCursor,
      transport: result.transport,
      warnings: result.warnings,
    };
  }
  async context(tabId, collectionId, title) {
    const account = await this.execute(tabId, instagramAccountContext, {});
    return {
      ok: true,
      threadId: collectionId
        ? `saved-${account.viewerId}-${collectionId}`
        : `saved-${account.viewerId}`,
      title: title || `Saved collection ${collectionId}`,
      collectionId,
      warnings: [
        "Captions and post links only. Publication dates unavailable in the saved collection API are left unknown. Media downloads are not included.",
      ],
    };
  }
  async posts(tabId, collectionId, cursor, expectedIdentity) {
    if (!/^\d+$/.test(collectionId || ""))
      throw new Error(
        "Choose a named saved collection; All posts is not supported by this query.",
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
        __relay_internal__pv__PolarisSEOIsCrawlerrelayprovider: false,
      },
    );
    if (!result.ok) return result;
    if (
      expectedIdentity &&
      expectedIdentity !== `saved-${result.viewerId}-${collectionId}`
    )
      throw new Error(
        "The Instagram account changed during collection. Prepare the source again.",
      );
    const collection = result.data?.fetch__MediaCollection;
    const connection = collection?.media;
    if (
      !Array.isArray(connection?.edges) ||
      typeof connection.page_info?.has_next_page !== "boolean" ||
      String(collection.id) !== collectionId
    )
      throw new Error(
        "Instagram saved collection contents response changed or selected another collection.",
      );
    const messages = connection.edges.map(({ node: post }) => {
      if (
        !post ||
        !/^\d+$/.test(String(post.pk || "")) ||
        !/^[A-Za-z0-9_-]+$/.test(post.code || "") ||
        (post.caption != null && typeof post.caption.text !== "string")
      )
        throw new Error("Instagram returned unsupported saved-post metadata.");
      const caption = post.caption?.text || "";
      return {
        id: String(post.pk),
        timestamp: Number.isFinite(post.taken_at) ? post.taken_at * 1000 : null,
        sender: post.user?.username || "Unknown author",
        senderId: String(post.user?.pk || ""),
        isMe: false,
        text: caption,
        caption,
        url: `https://www.instagram.com/p/${post.code}/`,
        type: "saved-post",
        attachments: [],
        reactions: [],
        raw: { code: post.code, media_type: post.media_type },
      };
    });
    const info = connection.page_info;
    if (info.has_next_page && (!info.end_cursor || info.end_cursor === cursor))
      throw new Error(
        "Instagram saved-post pagination did not advance its cursor.",
      );
    return {
      ok: true,
      page: {
        messages,
        hasMore: info.has_next_page,
        nextCursor: info.end_cursor || null,
      },
      title: collection.name,
      transport: result.transport,
      warnings: result.warnings,
    };
  }
}
