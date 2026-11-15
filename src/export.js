import { getPlatform } from "./platforms.js";
import { chronological, isMediaUrl } from "./model.js";
export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const safeName = (value) =>
  String(value)
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .slice(0, 100) || "conversation";
export function jsonReport(session) {
  return JSON.stringify(
    {
      schemaVersion: 2,
      platform: session.options.platform || "instagram",
      threadId: session.options.threadId,
      exportedAt: new Date().toISOString(),
      complete: session.complete,
      range: { start: session.options.start, end: session.options.end },
      warnings: session.warnings,
      messages: chronological(session.messages).map(({ raw, ...message }) =>
        session.options.raw ? { ...message, raw } : message,
      ),
    },
    null,
    2,
  );
}
export function textReport(session) {
  return [
    `${getPlatform(session.options.platform).label} conversation ${session.options.threadId}`,
    session.complete ? "Requested history complete" : "PARTIAL EXPORT",
    ...session.warnings,
    "",
    ...chronological(session.messages).map(
      (m) =>
        `[${new Date(m.timestamp).toLocaleString()}] ${m.sender}: ${m.text}${m.transcript ? "\nTranscript: " + m.transcript : ""}${m.attachments.map((a) => "\nAttachment: " + a.url).join("")}${m.reactions?.length ? "\nReactions: " + JSON.stringify(m.reactions) : ""}`,
    ),
  ].join("\n");
}
export function htmlReport(session, embedded = new Map(), paths = new Map()) {
  const e = escapeHtml;
  const rows = chronological(session.messages)
    .map((m) => {
      const media = m.attachments
        .map((a) => {
          if (!isMediaUrl(a.url)) return "";
          const data = embedded.get(a.url);
          const local = paths.get(a.url);
          const href = local || a.url;
          const image =
            ["image", "gif"].includes(a.type) && (data || local)
              ? `<img alt="Attachment from ${e(m.sender)}" src="${e(data || local)}" loading="lazy">`
              : "";
          return `<div>${image}<a href="${e(href)}" rel="noreferrer noopener" target="_blank">${e(a.type)} attachment${a.status === "failed" ? " (download failed)" : ""}</a></div>`;
        })
        .join("");
      return `<article class="${m.isMe ? "mine" : ""}"><header><strong>${e(m.sender)}</strong> <time>${e(new Date(m.timestamp).toLocaleString())}</time></header><p>${e(m.text)}</p>${m.transcript ? `<p><strong>Transcript</strong><br>${e(m.transcript)}</p>` : ""}${media}${m.reactions?.length ? `<p class="muted">Reactions: ${e(JSON.stringify(m.reactions))}</p>` : ""}</article>`;
    })
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${e(getPlatform(session.options.platform).label)} conversation ${e(session.options.threadId)}</title><style>body{font:16px/1.6 system-ui,sans-serif;color:#18202d;background:#f3f5f8;margin:0;padding:32px}main{max-width:820px;margin:auto}h1{font-size:26px}article{background:white;border:1px solid #cfd7e3;border-radius:12px;padding:16px;margin:16px 0;break-inside:avoid}.mine{border-left:4px solid #2757be}p{white-space:pre-wrap;overflow-wrap:anywhere}time,.muted{color:#505d70}time{font-size:13px}img{display:block;max-width:100%;max-height:600px}a{color:#174aa5;overflow-wrap:anywhere}@media print{body{background:white;padding:0}article{border-radius:0}a{color:inherit}}</style></head><body><main><h1>${e(getPlatform(session.options.platform).label)} conversation</h1><p>Thread ${e(session.options.threadId)} · ${session.messages.length} messages · ${session.complete ? "Requested history complete" : "PARTIAL EXPORT"}</p>${session.warnings.map((w) => `<p>${e(w)}</p>`).join("")}${rows}</main></body></html>`;
}
