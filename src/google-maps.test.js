import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { mapsListRequest, mapsPlaceRequest } from "./google-maps.js";
function fixture(html, path) {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const location = new URL("https://www.google.com" + path);
  const env = vm.createContext({
    document,
    location,
    URL,
    setTimeout: (fn) => {
      fn();
    },
  });
  return {
    document,
    location,
    run: (func, request = {}) =>
      vm.runInContext(`(${func.toString()})(${JSON.stringify(request)})`, env),
  };
}
test("Maps list reads only place links from its pane and verifies source identity", async () => {
  const f = fixture(
    '<div role="main"><h1>Food list</h1><div role="feed"><span>2 places </span><a href="https://www.google.com/maps/place/Cafe/" aria-label="Cafe"></a><a href="https://evil.com/maps/place/Bad">Bad</a></div></div>',
    "/maps/placelists/list/123",
  );
  const context = await f.run(mapsListRequest, { kind: "context" });
  assert.equal(context.title, "Food list");
  const result = await f.run(mapsListRequest, {
    kind: "entries",
    fingerprint: context.threadId,
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].name, "Cafe");
  assert.match(result.entries[0].url, /hl=en/);
  assert.equal(result.expectedCount, 2);
  f.document.querySelector("h1").textContent = "Another list";
  assert.match(
    (
      await f.run(mapsListRequest, {
        kind: "entries",
        fingerprint: context.threadId,
      })
    ).error,
    /list changed/,
  );
});
test("Maps details preserve full weekly hours, rating and review count, with missing fields explicit", async () => {
  const f = fixture(
    '<h1>Cafe</h1><button data-item-id="address" aria-label="Address: 123 Main St"></button><span aria-label="4.7 stars"></span><button aria-label="1,234 reviews"></button><table><tr><td>Monday</td><td>9 AM–5 PM</td></tr><tr><td>Tuesday</td><td>Closed</td></tr></table>',
    "/maps/place/Cafe/",
  );
  const { entry } = await f.run(mapsPlaceRequest);
  assert.equal(entry.address, "123 Main St");
  assert.equal(entry.rating, 4.7);
  assert.equal(entry.reviewCount, 1234);
  assert.equal(entry.hours[1].hours, "Closed");
  assert.equal(entry.unavailableFields.length, 0);
  const missing = await fixture("<h1>Park</h1>", "/maps/place/Park/").run(
    mapsPlaceRequest,
  );
  assert.equal(missing.entry.rating, null);
  assert.ok(missing.entry.unavailableFields.includes("hours"));
  const redirected = await fixture("<h1>Login</h1>", "/consent").run(
    mapsPlaceRequest,
  );
  assert.equal(redirected.ok, false);
});
