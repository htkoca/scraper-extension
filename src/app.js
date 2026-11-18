import { getPlatform } from "./platforms.js";
import { createSession, parseDateRange } from "./model.js";
import { fetchHistory, transcribe } from "./runner.js";
import { downloadMedia } from "./media.js";
import { downloadWhatsAppAudio } from "./whatsapp-media.js";
import { jsonReport, textReport, htmlReport, safeName } from "./export.js";
import { zipSync, strToU8 } from "fflate";
const $ = (id) => document.getElementById(id);
const tabId = Number(new URLSearchParams(location.search).get("tab"));
let context,
  session,
  controller,
  busy = false,
  media = null,
  mediaComplete = false,
  transcriptionComplete = false;
const savedPosts = () =>
  (session?.options.platform || context?.platform) === "instagram-saved";
const itemLabel = () => (savedPosts() ? "posts" : "messages");
const report = (text) => {
  $("progress").textContent = text;
  $("count").textContent =
    `${session?.messages.length.toLocaleString() || 0} ${itemLabel()}`;
};
const fail = (error) => {
  $("error").textContent = error.message || String(error);
  $("error").hidden = false;
};
const request = (body) =>
  chrome.runtime.sendMessage({
    type: "platform",
    platform: context?.platform,
    tabId,
    request: body,
  });
function refreshControls() {
  $("count").textContent =
    `${session?.messages.length.toLocaleString() || 0} ${itemLabel()}`;
  $("settings").disabled = busy;
  $("start").disabled = busy || !context;
  $("start").textContent = session
    ? "Start new collection"
    : context?.platform === "instagram-saved"
      ? "Collect saved posts"
      : "Collect conversation";
  $("pause").hidden = !busy;
  $("resume").hidden =
    busy ||
    !session ||
    (session.complete &&
      (!session.options.media || mediaComplete) &&
      (!session.options.transcribe || transcriptionComplete));
  $("reconnect").disabled = busy;
  for (const id of ["json", "txt", "html", "pdf", "zip"])
    $(id).disabled = busy || !session?.messages.length;
  $("warnings").replaceChildren(
    ...(session?.warnings || []).map((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      return li;
    }),
  );
}
async function connect() {
  $("error").hidden = true;
  try {
    const result = await request({ kind: "context" });
    if (!result?.ok)
      throw new Error(result?.error || "Could not connect to the source tab.");
    context = result;
    const platform = getPlatform(result.platform);
    for (const capability of ["media", "transcribe", "queryId"]) {
      const id = capability === "queryId" ? "query-id" : capability;
      $(id).disabled = !platform.capabilities[capability];
      $(id).closest(capability === "queryId" ? "details" : "label").hidden =
        !platform.capabilities[capability];
    }
    const saved = result.platform === "instagram-saved";
    $("media-label").textContent =
      result.platform === "whatsapp"
        ? "Download voice notes and audio"
        : "Download attachments";
    $("media-hint").textContent =
      result.platform === "whatsapp"
        ? "Audio files are included in the ZIP. Other media is not downloaded."
        : "Include images in HTML and PDF, and media files in a ZIP.";
    for (const id of ["from", "to"]) {
      $(id).disabled = saved;
      $(id).closest("label").hidden = saved;
    }
    $("limit-label").textContent = saved ? "Posts" : "Latest messages";
    $("limit").placeholder = saved ? "All saved posts" : "All messages";
    $("range-note").textContent = saved
      ? "Leave the limit blank for all available saved posts. Posts follow Instagram’s saved-feed order."
      : "Dates use your local timezone. Leave these fields blank for all available history.";
    $("platform-note").textContent = (result.warnings || []).join(" ");
    $("source").textContent =
      `Connected · ${platform.label} · ${result.title || result.threadId}`;
  } catch (error) {
    context = null;
    $("source").textContent = "No source connected";
    fail(error);
  }
  refreshControls();
}
async function collect() {
  if (busy || !session) return;
  busy = true;
  controller = new AbortController();
  $("error").hidden = true;
  refreshControls();
  const signal = controller.signal;
  try {
    await fetchHistory(session, { request, signal, progress: report });
    if (session.options.transcribe && !transcriptionComplete) {
      await transcribe(session, { request, signal, progress: report });
      transcriptionComplete = true;
    }
    if (session.options.media && !mediaComplete) {
      report("Downloading attachments…");
      media = await downloadMedia(session.messages, {
        signal,
        loadWhatsAppAudio: (attachment, options) =>
          downloadWhatsAppAudio(attachment, {
            ...options,
            request,
            threadId: session.options.threadId,
          }),
        progress: (done, total) => report(`Attachments: ${done} / ${total}`),
      });
      mediaComplete = true;
      if (media.failures.length)
        session.warnings.push(
          `${media.failures.length} attachments could not be downloaded. Message history is retained; details are in the ZIP's attachment-errors.json.`,
        );
    }
    report(
      session.messages.length
        ? `Collection complete. ${session.messages.length.toLocaleString()} ${itemLabel()} ready to save.`
        : `No ${itemLabel()} found.`,
    );
  } catch (error) {
    report(
      signal.aborted
        ? "Paused. Save a partial archive or resume."
        : "Collection stopped. Your collected items are still available.",
    );
    if (!signal.aborted) fail(error);
  } finally {
    busy = false;
    refreshControls();
  }
}
$("export-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (!context || busy) return;
    if (
      session?.messages.length &&
      !confirm(
        "Start over? Save the current archive first if you want to keep it.",
      )
    )
      return;
    const limit = $("limit").value ? Number($("limit").value) : null;
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1))
      throw new Error(
        "The limit must be a positive whole number, or blank for all available items.",
      );
    const range =
      context.platform === "instagram-saved"
        ? { start: null, end: null }
        : parseDateRange($("from").value, $("to").value);
    const options = {
      ...range,
      limit,
      platform: context.platform || "instagram",
      threadId: context.threadId,
      queryId: $("query-id").value,
      media: !$("media").disabled && $("media").checked,
      transcribe: !$("transcribe").disabled && $("transcribe").checked,
      raw: $("raw").checked,
    };
    // Store preferences only, never messages or authentication tokens.
    await chrome.storage.local.set({
      preferences: {
        queryId: options.queryId,
        media: options.media,
        transcribe: options.transcribe,
        raw: options.raw,
      },
    });
    session = createSession(options);
    session.warnings.push(...(context.warnings || []));
    media = null;
    mediaComplete = false;
    transcriptionComplete = false;
    await collect();
  } catch (error) {
    fail(error);
  }
});
$("resume").addEventListener("click", collect);
$("pause").addEventListener("click", () => {
  controller?.abort(new DOMException("Paused", "AbortError"));
  report("Pausing after the current request…");
});
$("reconnect").addEventListener("click", connect);
window.addEventListener("beforeunload", (event) => {
  if (busy) {
    event.preventDefault();
    event.returnValue = "";
  }
});
function download(data, type, extension) {
  const blob = new Blob([data], { type }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = `${session.options.platform}-${safeName(session.options.threadId)}-${new Date().toISOString().slice(0, 10)}${session.complete ? "" : "-partial"}.${extension}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
$("json").addEventListener("click", () =>
  download(jsonReport(session), "application/json", "json"),
);
$("txt").addEventListener("click", () =>
  download(textReport(session), "text/plain;charset=utf-8", "txt"),
);
$("html").addEventListener("click", () =>
  download(
    htmlReport(session, media?.embedded),
    "text/html;charset=utf-8",
    "html",
  ),
);
$("zip").addEventListener("click", () => {
  try {
    const files = Object.fromEntries(media?.files || []);
    const name = savedPosts() ? "saved-posts" : "conversation";
    files[`${name}.json`] = strToU8(jsonReport(session));
    files[`${name}.txt`] = strToU8(textReport(session));
    files[`${name}.html`] = strToU8(
      htmlReport(session, new Map(), media?.paths),
    );
    files["attachment-errors.json"] = strToU8(
      JSON.stringify(media?.failures || [], null, 2),
    );
    download(zipSync(files, { level: 0 }), "application/zip", "zip");
  } catch (error) {
    fail(error);
  }
});
$("pdf").addEventListener("click", () => {
  $("print").disabled = true;
  $("report").srcdoc = htmlReport(session, media?.embedded);
  $("preview").showModal();
});
$("report").addEventListener("load", () => {
  $("print").disabled = false;
});
$("print").addEventListener("click", () => {
  $("report").contentWindow.focus();
  $("report").contentWindow.print();
});
$("close-preview").addEventListener("click", () => $("preview").close());
async function boot() {
  try {
    const { preferences = {} } = await chrome.storage.local.get("preferences");
    for (const key of ["media", "transcribe", "raw"])
      if (key in preferences) $(key).checked = Boolean(preferences[key]);
    if (/^\d+$/.test(preferences.queryId))
      $("query-id").value = preferences.queryId;
    await connect();
  } catch (error) {
    fail(error);
  }
}
boot();
