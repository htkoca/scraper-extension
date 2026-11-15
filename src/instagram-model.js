import { isMediaUrl } from "./model.js";
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
