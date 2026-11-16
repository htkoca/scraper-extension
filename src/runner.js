import { acceptPage } from "./model.js";
import { getPlatform } from "./platforms.js";
export async function wait(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export async function fetchHistory(
  session,
  { request, signal, progress = () => {}, sleep = wait },
) {
  const platform = getPlatform(session.options.platform);
  while (!session.complete) {
    signal?.throwIfAborted();
    let result;
    for (let attempt = 0; attempt < 4; attempt++) {
      result = await request({
        kind: "messages",
        threadId: session.options.threadId,
        cursor: session.cursor,
        ...platform.messageRequest(session.options),
      });
      signal?.throwIfAborted();
      if (result.ok) break;
      if (![429, 500, 502, 503, 504].includes(result.status) || attempt === 3)
        throw new Error(result.error || `${platform.label} request failed.`);
      const retrySeconds = Number(result.retryAfter);
      const delay =
        Number.isFinite(retrySeconds) && retrySeconds > 0
          ? Math.min(retrySeconds * 1000, 60000)
          : 3000 * 2 ** attempt;
      progress(
        `${platform.label} is busy. Retrying in ${Math.ceil(delay / 1000)} seconds…`,
      );
      await sleep(delay, signal);
    }
    acceptPage(session, platform.page(result));
    progress(
      `${session.messages.length.toLocaleString()} ${platform.itemLabel || "messages"} collected · ${session.pages} pages`,
    );
    if (!session.complete) await sleep(600, signal);
  }
}
export async function transcribe(
  session,
  { request, signal, progress = () => {}, sleep = wait },
) {
  if (!getPlatform(session.options.platform).capabilities.transcribe)
    throw new Error("Voice transcription is unavailable for this platform.");
  const audio = [
    ...new Map(
      session.messages
        .flatMap((m) => m.attachments)
        .filter((a) => a.type === "audio" && a.mediaId)
        .map((a) => [a.mediaId, a]),
    ).values(),
  ];
  const cache = new Map();
  for (const m of session.messages)
    for (const [id, text] of Object.entries(m.transcripts || {}))
      cache.set(id, text);
  let done = 0;
  for (const attachment of audio) {
    signal?.throwIfAborted();
    if (!cache.has(attachment.mediaId)) {
      const result = await request({
        kind: "transcription",
        threadId: session.options.threadId,
        mediaId: attachment.mediaId,
        ...getPlatform(session.options.platform).transcriptionRequest(),
      });
      signal?.throwIfAborted();
      if (result.ok) cache.set(attachment.mediaId, result.transcript);
      else
        session.warnings.push(
          `Voice message ${attachment.mediaId}: ${result.error}`,
        );
      for (const message of session.messages) {
        const texts = message.attachments
          .filter((a) => a.type === "audio" && cache.has(a.mediaId))
          .map((a) => [a.mediaId, cache.get(a.mediaId)]);
        if (texts.length) {
          message.transcripts = Object.fromEntries(texts);
          message.transcript = [...new Set(texts.map((t) => t[1]))].join("\n");
        }
      }
      await sleep(800, signal);
    }
    progress(`Transcribing voice messages: ${++done} / ${audio.length}`);
  }
  const missing = session.messages
    .flatMap((m) => m.attachments)
    .filter((a) => a.type === "audio" && !a.mediaId).length;
  if (missing)
    session.warnings.push(
      `${missing} audio attachments have no transcription media ID.`,
    );
}
