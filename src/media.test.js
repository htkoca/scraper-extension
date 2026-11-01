import test from "node:test";
import assert from "node:assert/strict";
import { downloadMedia } from "./media.js";
test("media downloads deduplicate URLs and report failures instead of discarding history", async () => {
  const good = "https://a.fbcdn.net/voice.mp4",
    bad = "https://evil.example/file";
  const messages = [
    {
      attachments: [
        { url: good, type: "audio" },
        { url: bad, type: "image" },
      ],
    },
    { attachments: [{ url: good, type: "audio" }] },
  ];
  let count = 0;
  const result = await downloadMedia(messages, {
    fetcher: async (url, options) => {
      count++;
      assert.equal(url, good);
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      return {
        ok: true,
        blob: async () => new Blob(["audio bytes"], { type: "audio/mp4" }),
      };
    },
  });
  assert.equal(count, 1);
  assert.equal(result.files.size, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(messages[1].attachments[0].status, "downloaded");
});
test("media HTTP failures are explicit and no successful file is invented", async () => {
  const result = await downloadMedia(
    [{ attachments: [{ url: "https://a.fbcdn.net/x", type: "other" }] }],
    { fetcher: async () => ({ ok: false, status: 403 }) },
  );
  assert.equal(result.files.size, 0);
  assert.match(result.failures[0].error, /403/);
});
