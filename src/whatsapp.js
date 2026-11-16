// Runs only in the selected WhatsApp page; never sends messages or marks chats read.
export async function whatsappRequest(request) {
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
        "WhatsApp's message API is unavailable. Reload WhatsApp and try again.",
      );
    }
    const id = (value) => {
      if (typeof value === "string") return value;
      if (value?._serialized) return value._serialized;
      const text = value?.toString?.();
      return text && text !== "[object Object]" ? text : "";
    };
    const chat = request.targetId
      ? collections.Chat.get(request.targetId)
      : collections.Chat.getActive?.();
    const threadId = id(chat?.id);
    if (!threadId) throw new Error("Open a WhatsApp conversation first.");
    if (request.threadId && request.threadId !== threadId)
      throw new Error(
        "The WhatsApp tab changed conversations. Return to the original conversation to resume.",
      );
    if (!chat?.msgs?.getModelsArray)
      throw new Error(
        "This WhatsApp conversation is not loaded. Reopen it and try again.",
      );
    if (request.kind === "context")
      return {
        ok: true,
        threadId,
        title: chat.formattedTitle || chat.name || threadId,
        warnings: [
          "WhatsApp exports history available to this linked browser. Older phone history may be unavailable. Attachments are recorded as metadata. Media downloads, reactions, and voice transcription are not supported yet.",
        ],
      };
    const key = (message) => id(message.id);
    const sorted = () =>
      [...chat.msgs.getModelsArray()].sort(
        (a, b) => Number(b.t) - Number(a.t) || key(b).localeCompare(key(a)),
      );
    let messages = sorted();
    let offset = 0;
    if (request.cursor) {
      offset = messages.findIndex((m) => key(m) === request.cursor);
      if (offset < 0)
        throw new Error(
          "WhatsApp unloaded the pagination checkpoint. Start a new collection.",
        );
      offset++;
    }
    let exhausted = chat.msgs.msgLoadState?.noEarlierMsgs === true;
    if (offset === messages.length && !exhausted) {
      const loader = window.require("WAWebChatLoadMessages");
      if (typeof loader.loadEarlierMsgs !== "function")
        throw new Error(
          "WhatsApp's history loader changed. Collection stopped.",
        );
      const loaded = await loader.loadEarlierMsgs({ chat });
      if (!Array.isArray(loaded))
        throw new Error("WhatsApp returned an unsupported history response.");
      exhausted = loaded.length === 0;
      messages = sorted();
      offset = request.cursor
        ? messages.findIndex((m) => key(m) === request.cursor) + 1
        : 0;
      if (request.cursor && !offset)
        throw new Error(
          "WhatsApp unloaded the pagination checkpoint. Start a new collection.",
        );
      if (!exhausted && offset === messages.length)
        throw new Error(
          "WhatsApp did not advance its history checkpoint. Try resuming later.",
        );
    }
    // Recheck after async loading so a changed chat cannot be reported as complete.
    const current = id(
      (request.targetId
        ? collections.Chat.get(request.targetId)
        : collections.Chat.getActive?.()
      )?.id,
    );
    if (current !== threadId)
      throw new Error(
        "The WhatsApp tab changed conversations during collection.",
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
        quotedMessageId: m.quotedStanzaID || null,
      };
      return {
        id: raw.id,
        timestamp: raw.timestamp * 1000,
        senderId,
        sender: raw.fromMe
          ? "You"
          : contact?.name || contact?.pushname || senderId || "Unknown sender",
        isMe: raw.fromMe,
        text: String(m.body || m.caption || `[${type}]`),
        type,
        reactions: [],
        attachments: [],
        raw,
      };
    });
    return {
      ok: true,
      page: {
        messages: normalized,
        hasMore: !exhausted || offset + batch.length < messages.length,
        nextCursor: batch.length ? key(batch.at(-1)) : null,
      },
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}
