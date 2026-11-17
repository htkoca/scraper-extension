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
    const headingNode = document.querySelector(
      'h1,[role="heading"][aria-level="1"]',
    );
    const heading = headingNode?.textContent.trim();
    const listUrl = /(?:placelists\/list\/|!11m)/.test(url.href);
    let panel =
      document.querySelector('[role="feed"]') ||
      [...document.querySelectorAll('[role="main"]')].find((el) =>
        el.querySelector('a[href*="/maps/place/"]'),
      );
    const label = (el) => {
      if (el.getAttribute("aria-label"))
        return el.getAttribute("aria-label").trim();
      const copy = el.cloneNode(true);
      copy
        .querySelectorAll(
          '[aria-hidden="true"],svg,.google-symbols,.material-icons',
        )
        .forEach((node) => node.remove());
      return copy.textContent.replace(/\s+/g, " ").trim();
    };
    const placeButtons = (root) => {
      const all = [...root.querySelectorAll('button,[role="button"]')];
      const places = new Set();
      const notes = [
        ...all.filter((button) => label(button) === "Add note"),
        ...root.querySelectorAll(
          '[aria-label="Note"],textarea[placeholder="Note"]',
        ),
      ];
      for (const note of notes) {
        let parent = note.parentElement;
        for (
          let depth = 0;
          parent && depth < 4;
          depth++, parent = parent.parentElement
        ) {
          if (parent.querySelector('h1,[role="heading"][aria-level="1"]'))
            break;
          const buttons = [
            ...parent.querySelectorAll('button,[role="button"]'),
          ];
          const place = buttons.find((el) => label(el) !== "Add note");
          if (place) {
            places.add(place);
            break;
          }
        }
      }
      return [...places];
    };
    if (!panel && headingNode) {
      let parent = headingNode.parentElement;
      while (parent && parent !== document.body) {
        if (placeButtons(parent).length) {
          panel = parent;
          break;
        }
        parent = parent.parentElement;
      }
    }
    if (
      !heading ||
      !listUrl ||
      (!panel &&
        !/0 places|no places|empty list/i.test(
          document.body.innerText || document.body.textContent || "",
        )) ||
      document.querySelector('[data-item-id="address"]')
    )
      throw new Error(
        "Open the saved list itself, with its places visible, rather than a place detail or search.",
      );
    const listIdentity =
      /!11m\d+!2s([^!]+)/.exec(url.href)?.[1] ||
      /placelists\/list\/([^/?]+)/.exec(url.href)?.[1];
    const fingerprint = `${url.origin}#${listIdentity || url.pathname}#${heading}`;
    if (request.fingerprint && request.fingerprint !== fingerprint)
      throw new Error(
        "The selected Maps list changed. Select the source again.",
      );
    if (request.kind === "context")
      return {
        ok: true,
        threadId: fingerprint,
        title: heading,
        buttonLayout: Boolean(panel && placeButtons(panel).length),
      };
    if (request.kind !== "entries") throw new Error("Unknown Maps request.");
    let scroller =
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
    if (!links.length && panel) {
      // Resolve actual destinations in a disposable scan tab, never in the user's source tab.
      const names = placeButtons(panel).map(label);
      for (const name of names
        .filter((name) => !request.resolvedNames?.includes(name))
        .slice(0, request.limit || undefined)) {
        let button = placeButtons(panel).find((el) => label(el) === name);
        if (!button)
          throw new Error(
            "Maps changed its visible place rows while scanning.",
          );
        button.click();
        let destination;
        for (let attempt = 0; attempt < 40; attempt++) {
          if (location.pathname.startsWith("/maps/place/")) {
            destination = location.href;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!destination)
          throw new Error(`Maps did not expose the destination for ${name}.`);
        history.back();
        let restored = false;
        for (let attempt = 0; attempt < 40; attempt++) {
          // React can replace the list pane after navigation.
          const title = document.querySelector(
            'h1,[role="heading"][aria-level="1"]',
          );
          let parent = title?.parentElement;
          while (parent && parent !== document.body) {
            if (placeButtons(parent).length) {
              panel = parent;
              break;
            }
            parent = parent.parentElement;
          }
          const returned = new URL(location.href);
          const returnedId =
            /!11m\d+!2s([^!]+)/.exec(returned.href)?.[1] ||
            /placelists\/list\/([^/?]+)/.exec(returned.pathname)?.[1];
          if (
            returned.origin === url.origin &&
            returnedId === listIdentity &&
            title?.textContent.trim() === heading &&
            panel?.isConnected &&
            placeButtons(panel).length
          ) {
            restored = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!restored)
          throw new Error("Maps did not return to the original saved list.");
        const place = new URL(destination);
        place.searchParams.set("hl", "en");
        entries.push({ name, url: place.href });
      }
    }
    if (
      !entries.length &&
      !(panel && placeButtons(panel).length) &&
      !/0 places|no places|empty list/i.test(document.body.innerText || "")
    )
      throw new Error(
        "No supported place links found. Load the list, or its layout may have changed.",
      );
    if (panel && !scroller?.isConnected)
      scroller = [panel, ...panel.querySelectorAll("div")]
        .filter(
          (el) =>
            el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 100,
        )
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    const before = scroller?.scrollTop || 0;
    const atEnd =
      !scroller || before + scroller.clientHeight >= scroller.scrollHeight - 5;
    if (scroller)
      scroller.scrollTop = before + Math.max(300, scroller.clientHeight * 0.8);
    const countText =
      (panel || document).innerText || (panel || document).textContent || "";
    const expected = /([\d,]+)\s+places?\b/i.exec(countText);
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
    const addressNode = document.querySelector('[data-item-id="address"]');
    const details = addressNode?.closest('[role="main"]') || document;
    const titleNode = [...details.querySelectorAll("h1")].at(-1);
    const title = titleNode?.textContent.trim();
    const address = (
      addressNode?.getAttribute("aria-label")?.replace(/^Address:\s*/i, "") ||
      addressNode?.querySelector(".fontBodyMedium")?.textContent ||
      ""
    ).trim();
    if (title && (address || attempt === 29)) {
      const hoursButton = details.querySelector(
        '[data-item-id="oh"], button[aria-label*="Show open hours"], [role="button"][aria-label*="Show open hours"]',
      );
      hoursButton?.click();
      if (hoursButton) await sleep(400);
      const hours = [...details.querySelectorAll("table tr")]
        .map((row) => {
          const cells = [...row.querySelectorAll("td")].map((el) =>
            el.textContent.replace(/\p{Co}/gu, "").trim(),
          );
          return cells.length >= 2 &&
            /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.test(
              cells[0],
            ) &&
            cells.slice(1).some(Boolean)
            ? { day: cells[0], hours: cells.slice(1).join(" ") }
            : null;
        })
        .filter(Boolean);
      const labels = [...details.querySelectorAll("[aria-label]")].map((el) =>
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
