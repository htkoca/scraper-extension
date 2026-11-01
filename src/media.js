import { isMediaUrl } from "./model.js";
import { safeName } from "./export.js";
export async function downloadMedia(
  messages,
  { signal, progress = () => {}, fetcher = fetch } = {},
) {
  const files = new Map(),
    paths = new Map(),
    embedded = new Map(),
    failures = [];
  const attachments = [
    ...new Map(
      messages.flatMap((m) => m.attachments).map((a) => [a.url, a]),
    ).values(),
  ];
  let index = 0,
    done = 0;
  async function worker() {
    while (index < attachments.length) {
      signal?.throwIfAborted();
      const i = index++,
        a = attachments[i];
      try {
        if (!isMediaUrl(a.url)) throw new Error("Not an allowed Meta CDN URL");
        const response = await fetcher(a.url, {
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.any([
            signal || new AbortController().signal,
            AbortSignal.timeout(25000),
          ]),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (!blob.size) throw new Error("Empty attachment");
        const mime = blob.type.split(";")[0];
        const ext =
          {
            "image/jpeg": "jpg",
            "image/png": "png",
            "image/webp": "webp",
            "image/gif": "gif",
            "video/mp4": "mp4",
            "audio/mp4": "m4a",
            "audio/mpeg": "mp3",
            "audio/ogg": "ogg",
            "video/webm": "webm",
          }[mime] || "bin";
        const path = `attachments/${String(i + 1).padStart(6, "0")}-${safeName(a.type)}.${ext}`;
        files.set(path, new Uint8Array(await blob.arrayBuffer()));
        paths.set(a.url, path);
        if (
          ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime)
        ) {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          embedded.set(a.url, dataUrl);
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        failures.push({ url: a.url, error: error.message });
      }
      progress(++done, attachments.length);
    }
  }
  // Wait for all workers before returning or allowing another export to start.
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(3, attachments.length) }, worker),
  );
  const rejected = results.find((r) => r.status === "rejected");
  if (rejected) throw rejected.reason;
  for (const message of messages)
    for (const a of message.attachments)
      a.status = paths.has(a.url) ? "downloaded" : "failed";
  return { files, paths, embedded, failures };
}
