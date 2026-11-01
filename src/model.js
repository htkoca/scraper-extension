export function isMediaUrl(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      ["cdninstagram.com", "fbcdn.net", "fbsbx.com"].some(
        (host) => u.hostname === host || u.hostname.endsWith("." + host),
      )
    );
  } catch {
    return false;
  }
}

export function attachmentsFrom(node) {
  const found = new Map();
  const walk = (value, path = "", depth = 0, inheritedId = null) => {
    if (
      !value ||
      depth > 12 ||
      /sender|profile|avatar|reaction|user_dict/i.test(path)
    )
      return;
    if (typeof value === "string") {
      if (!isMediaUrl(value)) return;
      const context = path + " " + value.split("?")[0];
      const type = /audio|voice|opus|m4a|aac|mp3/i.test(context)
        ? "audio"
        : /video|playable|mp4|webm/i.test(context)
          ? "video"
          : /gif|animated/i.test(context)
            ? "gif"
            : /image|photo|preview|thumbnail|jpe?g|png|webp/i.test(context)
              ? "image"
              : "other";
      const old = found.get(value);
      if (!old || old.type === "other")
        found.set(value, {
          url: value,
          type,
          mediaId: inheritedId,
          status: "not-downloaded",
        });
      return;
    }
    if (Array.isArray(value)) {
      const items = /candidates|video_versions/.test(path)
        ? [...value].sort((a, b) => (b.width || 0) - (a.width || 0)).slice(0, 1)
        : value;
      items.forEach((item) => walk(item, path, depth + 1, inheritedId));
    } else if (typeof value === "object") {
      const mediaId = value.attachment_fbid || value.media_id || inheritedId;
      for (const [key, child] of Object.entries(value))
        walk(
          child,
          path + "." + key,
          depth + 1,
          mediaId ? String(mediaId) : null,
        );
    }
  };
  walk(node.content || node);
  return [...found.values()];
}

export function normalizeMessage(node, viewerId) {
  const timestamp = Number(node.timestamp_ms);
  if (!Number.isFinite(timestamp) || timestamp < 0)
    throw new Error(
      "A message has an invalid timestamp. Export paused to avoid silently losing data.",
    );
  const senderId = String(
    node.sender?.user_dict?.id || node.sender?.igid || node.sender_fbid || "",
  );
  const sender =
    node.sender?.name ||
    node.sender?.user_dict?.username ||
    senderId ||
    "Unknown sender";
  const attachments = attachmentsFrom(node);
  const type = node.content?.__typename || node.__typename || "unknown";
  const text =
    node.text_body ||
    node.content?.text_body ||
    node.content?.text ||
    (attachments.length
      ? `[${[...new Set(attachments.map((a) => a.type))].join(", ")} attachment]`
      : `[${type}]`);
  const id = String(
    node.message_id ||
      node.item_id ||
      node.id ||
      `${timestamp}:${senderId}:${text}`,
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
    raw: node,
  };
}

export function parseDateRange(from, to) {
  const start = from ? new Date(from + "T00:00:00").getTime() : null;
  const end = to ? new Date(to + "T23:59:59.999").getTime() : null;
  if (
    (start !== null && !Number.isFinite(start)) ||
    (end !== null && !Number.isFinite(end))
  )
    throw new Error("Choose valid dates.");
  if (start !== null && end !== null && start > end)
    throw new Error("The start date must be before the end date.");
  return { start, end };
}

export function createSession(options) {
  return {
    options: { ...options },
    messages: [],
    seen: new Set(),
    cursors: new Set(),
    cursor: null,
    pages: 0,
    complete: false,
    warnings: [],
  };
}

export function acceptPage(session, connection, viewerId) {
  if (
    !Array.isArray(connection?.edges) ||
    typeof connection.page_info?.has_next_page !== "boolean"
  )
    throw new Error("Unsupported Instagram response.");
  const next = connection.page_info.end_cursor;
  const more = connection.page_info.has_next_page;
  if (more && (!next || next === session.cursor || session.cursors.has(next)))
    throw new Error(
      "Instagram repeated a pagination cursor. Export paused to avoid looping.",
    );
  if (more && connection.edges.length === 0)
    throw new Error(
      "Instagram returned an empty page with more history. Try resuming later.",
    );
  // Validate the whole page before advancing its checkpoint.
  const normalized = connection.edges
    .filter((e) => e.node)
    .map((e) => normalizeMessage(e.node, viewerId));
  let older = false,
    limitReached = false;
  for (const message of normalized) {
    if (
      session.options.start !== null &&
      message.timestamp < session.options.start
    ) {
      older = true;
      continue;
    }
    if (session.options.end !== null && message.timestamp > session.options.end)
      continue;
    if (session.seen.has(message.id)) continue;
    if (
      session.options.limit &&
      session.messages.length >= session.options.limit
    ) {
      limitReached = true;
      break;
    }
    session.seen.add(message.id);
    session.messages.push(message);
  }
  session.pages++;
  if (next) session.cursors.add(next);
  session.cursor = next || null;
  session.complete =
    !more ||
    older ||
    limitReached ||
    Boolean(
      session.options.limit && session.messages.length >= session.options.limit,
    );
}

export function chronological(messages) {
  return [...messages].sort(
    (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
  );
}
