export function isWhatsAppAudio(attachment) {
  return (
    attachment.provider === "whatsapp" &&
    attachment.type === "audio" &&
    typeof attachment.messageId === "string" &&
    attachment.messageId.length > 0 &&
    attachment.url ===
      `whatsapp:audio/${encodeURIComponent(attachment.messageId)}`
  );
}

export async function downloadWhatsAppAudio(
  attachment,
  { request, threadId, signal },
) {
  if (!isWhatsAppAudio(attachment))
    throw new Error("Invalid WhatsApp audio reference.");
  const parts = [];
  let offset = 0,
    total,
    mime;
  do {
    signal?.throwIfAborted();
    const chunk = await request({
      kind: "media",
      threadId,
      messageId: attachment.messageId,
      offset,
    });
    signal?.throwIfAborted();
    if (!chunk?.ok)
      throw new Error(chunk?.error || "WhatsApp audio did not respond.");
    if (
      chunk.messageId !== attachment.messageId ||
      chunk.offset !== offset ||
      !Number.isSafeInteger(chunk.totalBytes) ||
      chunk.totalBytes <= offset ||
      !/^audio\/[a-z0-9.+-]+$/.test(chunk.mime) ||
      typeof chunk.data !== "string" ||
      chunk.data.length > 262144 ||
      (offset > 0 && (chunk.totalBytes !== total || chunk.mime !== mime))
    )
      throw new Error("WhatsApp returned an inconsistent audio chunk.");
    total = chunk.totalBytes;
    mime = chunk.mime;
    const bytes = Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0));
    const next = offset + bytes.length;
    if (
      !bytes.length ||
      next > total ||
      chunk.nextOffset !== (next === total ? null : next)
    )
      throw new Error("WhatsApp returned an invalid audio checkpoint.");
    parts.push(bytes);
    offset = chunk.nextOffset;
  } while (offset !== null);
  return new Blob(parts, { type: mime });
}
