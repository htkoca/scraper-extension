export const DEFAULT_QUERY_ID = "27048827731415519";
export const TRANSCRIPTION_QUERY_ID = "35263279109985185";

// This function is serialized by Chrome and runs inside the selected Instagram tab.
export async function instagramRequest(request) {
  try {
    if (location.origin !== "https://www.instagram.com")
      throw new Error("Open a conversation on www.instagram.com first.");
    const threadId = location.pathname.match(/^\/direct\/t\/(\d+)\/?$/)?.[1];
    if (!threadId) throw new Error("Open an Instagram conversation first.");
    if (request.threadId && request.threadId !== threadId)
      throw new Error(
        "The Instagram tab changed conversations. Return to the original conversation to resume.",
      );
    if (request.kind === "context")
      return { ok: true, threadId, title: document.title };
    const scripts = Array.from(
      document.scripts,
      (s) => s.textContent || "",
    ).join("\n");
    const token = (name) => {
      const match = scripts.match(
        new RegExp(
          '"' +
            name +
            '"\\s*,\\s*\\[\\]\\s*,\\s*\\{\\s*"token"\\s*:\\s*"([^"\\n]+)"',
        ),
      );
      if (match) return match[1];
      try {
        return window.require?.(name)?.token;
      } catch {
        return undefined;
      }
    };
    const dtsg = token("DTSGInitialData"),
      lsd = token("LSD");
    const cookie = (name) =>
      document.cookie
        .split("; ")
        .find((c) => c.startsWith(name + "="))
        ?.slice(name.length + 1);
    const csrf = cookie("csrftoken");
    if (!dtsg || !lsd || !csrf)
      throw new Error(
        "Instagram authentication tokens are unavailable. Reload the Instagram tab and try again.",
      );
    const transcription = request.kind === "transcription";
    const friendly = transcription
      ? "IGDAudioTranscriptionButtonOffMsysMutation"
      : "IGDMessageListOffMsysQuery";
    let queryId = request.queryId;
    try {
      queryId = window.require?.(friendly + ".graphql")?.params?.id || queryId;
    } catch {
      /* Use the configured fallback. */
    }
    const variables = transcription
      ? { input: { media_id: request.mediaId } }
      : {
          id: threadId,
          first: 20,
          after: request.cursor || null,
          before: null,
          last: null,
          __relay_internal__pv__IGDInitialMessagePageCountrelayprovider: 20,
        };
    const response = await fetch("/api/graphql", {
      method: "POST",
      credentials: "include",
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
        error: `Instagram returned HTTP ${response.status}.`,
        retryAfter: response.headers.get("Retry-After"),
      };
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(
        "Instagram returned a non-JSON response. Check your login or account prompts.",
      );
    }
    if (body.errors?.length)
      throw new Error(
        "Instagram API: " +
          body.errors.map((e) => e.message || "Unknown error").join("; "),
      );
    if (transcription) {
      const transcript =
        body.data?.xig_media_message_transcription?.edges?.[0]?.node;
      if (typeof transcript !== "string")
        throw new Error(
          "Instagram did not return a transcript for this voice message.",
        );
      return { ok: true, transcript };
    }
    const connection =
      body.data?.fetch__SlideThread?.as_ig_direct_thread?.slide_messages;
    if (
      !Array.isArray(connection?.edges) ||
      !connection.page_info ||
      typeof connection.page_info.has_next_page !== "boolean"
    ) {
      throw new Error(
        "Instagram’s response format changed or this thread is unsupported. No successful export was reported.",
      );
    }
    return { ok: true, connection, viewerId: cookie("ds_user_id") || null };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}
