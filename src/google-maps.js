// These functions run in the selected Maps page, without extension privileges.
export async function mapsListRequest(request) {
  try {
    const url = new URL(location.href);
    if (
      url.protocol !== "https:" ||
      !["www.google.com", "maps.google.com"].includes(url.hostname) ||
      (url.hostname === "www.google.com" && !url.pathname.startsWith("/maps"))
    )
      throw new Error("Open a Google Maps saved list first.");
    const heading = document
      .querySelector('[role="main"] h1, h1')
      ?.textContent.trim();
    const listUrl = /(?:placelists\/list\/|!11m)/.test(url.href);
    const panel =
      document.querySelector('[role="feed"]') ||
      [...document.querySelectorAll('[role="main"]')].find((el) =>
        el.querySelector('a[href*="/maps/place/"]'),
      );
    if (
      !heading ||
      !listUrl ||
      document.querySelector('[data-item-id="address"]')
    )
      throw new Error(
        "Open the saved list itself, with its places visible, rather than a place detail or search.",
      );
    const fingerprint = `${location.href}#${heading}`;
    if (request.fingerprint && request.fingerprint !== fingerprint)
      throw new Error(
        "The selected Maps list changed. Select the source again.",
      );
    if (request.kind === "context")
      return { ok: true, threadId: fingerprint, title: heading };
    if (request.kind !== "entries") throw new Error("Unknown Maps request.");
    const scroller =
      panel &&
      [panel, ...panel.querySelectorAll("div")]
        .filter(
          (el) =>
            el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 100,
        )
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (request.reset && scroller) {
      scroller.scrollTop = 0;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const links = [
      ...(panel || document).querySelectorAll('a[href*="/maps/place/"]'),
    ];
    const entries = [];
    for (const link of links) {
      const place = new URL(link.href, location.href);
      if (
        place.origin !== url.origin ||
        !place.pathname.startsWith("/maps/place/")
      )
        continue;
      place.searchParams.set("hl", "en");
      const name =
        link.getAttribute("aria-label")?.trim() || link.textContent.trim();
      entries.push({ url: place.href, name: name || null });
    }
    if (
      !entries.length &&
      !/0 places|no places|empty list/i.test(document.body.innerText || "")
    )
      throw new Error(
        "No supported place links found. Load the list, or its layout may have changed.",
      );
    const before = scroller?.scrollTop || 0;
    const atEnd =
      !scroller || before + scroller.clientHeight >= scroller.scrollHeight - 5;
    if (scroller)
      scroller.scrollTop = before + Math.max(300, scroller.clientHeight * 0.8);
    const countText =
      (panel || document).innerText || (panel || document).textContent || "";
    const expected = /([\d,]+)\s+places\b/i.exec(countText);
    return {
      ok: true,
      entries,
      atEnd,
      expectedCount: expected ? Number(expected[1].replaceAll(",", "")) : null,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function mapsPlaceRequest() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (
    !["www.google.com", "maps.google.com"].includes(location.hostname) ||
    !location.pathname.startsWith("/maps/place/")
  )
    return { ok: false, error: "The place redirected outside Google Maps." };
  for (let attempt = 0; attempt < 30; attempt++) {
    const title = document.querySelector("h1")?.textContent.trim();
    const address =
      document
        .querySelector('[data-item-id="address"]')
        ?.getAttribute("aria-label")
        ?.replace(/^Address:\s*/i, "") ||
      document
        .querySelector('[data-item-id="address"] .fontBodyMedium')
        ?.textContent.trim();
    if (title && (address || attempt === 29)) {
      const hoursButton = document.querySelector(
        '[data-item-id="oh"], button[aria-label*="Show open hours"], [role="button"][aria-label*="Show open hours"]',
      );
      hoursButton?.click();
      if (hoursButton) await sleep(400);
      const hours = [...document.querySelectorAll("table tr")]
        .map((row) => {
          const cells = [...row.querySelectorAll("td")].map((el) =>
            el.textContent.trim(),
          );
          return cells.length >= 2
            ? { day: cells[0], hours: cells.slice(1).join(" ") }
            : null;
        })
        .filter(Boolean);
      const labels = [...document.querySelectorAll("[aria-label]")].map((el) =>
        el.getAttribute("aria-label"),
      );
      const ratingLabel = labels.find((label) =>
        /^\d(?:[.,]\d+)?\s+(?:stars|out of 5)/i.test(label),
      );
      const reviewLabel = labels.find((label) =>
        /^[\d,.]+\s+reviews\b/i.test(label),
      );
      const rating = ratingLabel
        ? Number(ratingLabel.match(/^[\d.,]+/)[0].replace(",", "."))
        : null;
      const reviewCount = reviewLabel
        ? Number(reviewLabel.match(/^[\d,.]+/)[0].replace(/[,.]/g, ""))
        : null;
      return {
        ok: true,
        entry: {
          name: title,
          address: address || null,
          hours: hours.length ? hours : null,
          hoursSummary: hoursButton?.getAttribute("aria-label") || null,
          rating,
          reviewCount,
          url: location.href,
          unavailableFields: [
            !address && "address",
            !hours.length && "hours",
            rating === null && "rating",
            reviewCount === null && "reviewCount",
          ].filter(Boolean),
        },
      };
    }
    await sleep(500);
  }
  return {
    ok: false,
    error: "Place details did not load. Check Maps consent or sign-in prompts.",
  };
}
