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

export function acceptPage(session, connection) {
  const saved = session.options.platform === "instagram-saved";
  if (saved && (session.options.start != null || session.options.end != null))
    throw new Error("Date filters are unavailable for saved posts.");
  if (
    !Array.isArray(connection?.messages) ||
    typeof connection.hasMore !== "boolean"
  )
    throw new Error("Unsupported conversation response.");
  const next = connection.nextCursor;
  const more = connection.hasMore;
  if (more && (!next || next === session.cursor || session.cursors.has(next)))
    throw new Error(
      "The platform repeated a pagination cursor. Export paused to avoid looping.",
    );
  if (more && connection.messages.length === 0)
    throw new Error(
      "The platform returned an empty page with more history. Try resuming later.",
    );
  // Validate the whole page before advancing its checkpoint.
  const normalized = connection.messages;
  for (const message of normalized) {
    const unknownDate = saved && message.timestamp === null;
    if (
      !message.id ||
      (!unknownDate &&
        (!Number.isFinite(message.timestamp) || message.timestamp < 0))
    )
      throw new Error(
        "A message has an invalid ID or timestamp. Collection paused.",
      );
  }
  let older = false,
    limitReached = false;
  for (const message of normalized) {
    if (
      session.options.start != null &&
      message.timestamp < session.options.start
    ) {
      older = true;
      continue;
    }
    if (session.options.end != null && message.timestamp > session.options.end)
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
