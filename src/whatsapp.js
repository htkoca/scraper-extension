// Runs only in the selected WhatsApp page; never sends messages or marks chats read.
export async function whatsappRequest(request) {
  try {
    if (location.origin !== "https://web.whatsapp.com")
      throw new Error("Open web.whatsapp.com first.");
    if (!["context", "messages", "media"].includes(request.kind))
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
          "WhatsApp exports history available to this linked browser. Older phone history may be unavailable. Voice notes and audio can be downloaded in a ZIP. Other media, reactions, and voice transcription are not supported.",
        ],
      };
    const key = (message) => id(message.id);
    if (request.kind === "media") {
      const offset = request.offset ?? 0;
      if (
        !request.threadId ||
        !request.messageId ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        throw new Error(
          "Audio requires a conversation, message ID, and nonnegative byte offset.",
        );
      const message = chat.msgs
        .getModelsArray()
        .find((m) => key(m) === request.messageId);
      if (!message)
        throw new Error(
          "WhatsApp unloaded this message. Collect the conversation again.",
        );
      if (!["ptt", "audio"].includes(message.type) || message.isViewOnce)
        throw new Error(
          "Only ordinary WhatsApp voice notes and audio are supported.",
        );
      const getBlob = () => {
        let cached;
        try {
          cached = window
            .require("WAWebMediaInMemoryBlobCache")
            .InMemoryMediaBlobCache.get(message.mediaObject?.filehash);
        } catch {
          /* Older clients may only expose mediaBlob. */
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
              isUserInitiated: true,
            }),
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error("WhatsApp audio download timed out. Try again."),
                  ),
                25000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        blob = getBlob();
      }
      if (!(blob instanceof Blob) || !blob.size)
        throw new Error(
          "This audio is unavailable to the linked browser. Try downloading it in WhatsApp first.",
        );
      const mime = String(message.mimetype || blob.type)
        .split(";")[0]
        .toLowerCase();
      if (!/^audio\/[a-z0-9.+-]+$/.test(mime))
        throw new Error("WhatsApp returned an unsupported audio format.");
      if (offset >= blob.size)
        throw new Error("Audio offset is past the end of the file.");
      const bytes = new Uint8Array(
        await blob.slice(offset, offset + 196608).arrayBuffer(),
      );
      if (
        location.origin !== "https://web.whatsapp.com" ||
        (request.targetId
          ? collections.Chat.get(request.targetId)
          : collections.Chat.getActive?.()) !== chat ||
        !chat.msgs.getModelsArray().includes(message) ||
        message.isViewOnce
      )
        throw new Error(
          "The WhatsApp conversation changed during audio download.",
        );
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return {
        ok: true,
        messageId: key(message),
        offset,
        totalBytes: blob.size,
        mime,
        data: btoa(binary),
        nextOffset:
          offset + bytes.length < blob.size ? offset + bytes.length : null,
      };
    }
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
        attachments:
          ["ptt", "audio"].includes(type) && !m.isViewOnce
            ? [
                {
                  type: "audio",
                  provider: "whatsapp",
                  messageId: raw.id,
                  url: `whatsapp:audio/${encodeURIComponent(raw.id)}`,
                  mime: raw.mimetype,
                },
              ]
            : [],
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
