import test from "node:test";
import assert from "node:assert/strict";
import { chooseProfile, connectProfile } from "./profiles.mjs";
const catalog = [
  { directory: "Default", name: "Work", email: "work@example.com" },
  { directory: "Profile 1", name: "Personal", email: "personal@example.com" },
];
test("profile aliases select the exact personal account and never fall back to work", () => {
  for (const name of [
    "Personal",
    "personal@example.com",
    "personal@example.com",
    "Profile 1",
  ])
    assert.equal(chooseProfile(catalog, name).directory, "Profile 1");
  assert.throws(
    () => chooseProfile(catalog.slice(0, 1), "Personal"),
    /not found/,
  );
  assert.throws(
    () => chooseProfile([...catalog, catalog[1]], "personal@example.com"),
    /ambiguous/,
  );
});
test("already paired default profile reuses its connection and ignores work", async () => {
  const result = await connectProfile("Personal", {
    profiles: async () => catalog,
    connections: async () => ["work", "personal"],
    call: async (id) => ({
      profile: { directory: id === "personal" ? "Profile 1" : "Default" },
    }),
    launch: async () => {
      throw new Error("Unexpected launch");
    },
  });
  assert.equal(result.connectionId, "personal");
});
test("disconnected profile launches exact directory and requires its nonce before connecting", async () => {
  let challenge;
  let attempts = 0;
  const result = await connectProfile("personal@example.com", {
    profiles: async () => catalog,
    connections: async () => ["work", "personal"],
    call: async (id) => {
      if (id === "work")
        return { profile: { directory: "Default", nonce: challenge } };
      if (!challenge) return { profile: null };
      attempts++;
      return {
        profile: {
          directory: "Profile 1",
          nonce: attempts === 1 ? "wrong-nonce" : challenge,
        },
      };
    },
    launch: async (profile, url) => {
      assert.equal(profile.directory, "Profile 1");
      const parsed = new URL(url);
      assert.equal(parsed.protocol, "chrome-extension:");
      const params = new URLSearchParams(parsed.hash.slice(1));
      assert.equal(params.get("profile"), "Profile 1");
      challenge = params.get("nonce");
    },
    sleep: async () => {},
  });
  assert.equal(attempts, 2);
  assert.equal(result.connectionId, "personal");
});
test("opening profile without an installed bridge reports setup instead of selecting another account", async () => {
  await assert.rejects(
    connectProfile("Personal", {
      profiles: async () => catalog,
      connections: async () => ["work"],
      call: async () => ({ profile: { directory: "Default" } }),
      launch: async () => {},
      sleep: async () => {},
    }),
    /Load the extension/,
  );
});

test("unconfigured multiple profiles require a choice and a single profile is usable", () => {
  assert.throws(() => chooseProfile(catalog, ""), /Choose a Chrome profile/);
  assert.equal(chooseProfile([catalog[1]], "").directory, "Profile 1");
});
