import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { connections, callBridge } from "./client.mjs";

export function chromeDataDirectory() {
  return (
    process.env.SCRAPER_CHROME_DATA_DIR ||
    (process.platform === "darwin"
      ? join(homedir(), "Library/Application Support/Google/Chrome")
      : join(homedir(), ".config/google-chrome"))
  );
}
export async function profiles(directory = chromeDataDirectory()) {
  const state = JSON.parse(
    await readFile(join(directory, "Local State"), "utf8"),
  );
  return Object.entries(state.profile?.info_cache || {}).map(
    ([directory, value]) => ({
      directory,
      name: value.name || directory,
      email: value.user_name || "",
    }),
  );
}
export function chooseProfile(
  items,
  selector = process.env.SCRAPER_CHROME_PROFILE,
) {
  if (!selector) {
    if (items.length === 1) return items[0];
    throw new Error(
      "Choose a Chrome profile with connect_browser, or set SCRAPER_CHROME_PROFILE locally. Use list_profiles to see available profiles.",
    );
  }
  const normalized = selector.toLowerCase();
  const matches = items.filter((item) =>
    [item.directory, item.name, item.email].some(
      (value) => value.toLowerCase() === normalized,
    ),
  );
  if (matches.length !== 1)
    throw new Error(
      `Chrome profile "${selector}" ${matches.length ? "is ambiguous" : "was not found"}. Use an exact directory, name, or email from list_profiles.`,
    );
  return matches[0];
}
export async function launchProfile(profile, url) {
  if (!/^(Default|Profile \d+)$/.test(profile.directory))
    throw new Error("Unsupported Chrome profile directory.");
  const args = [
    `--profile-directory=${profile.directory}`,
    `--user-data-dir=${chromeDataDirectory()}`,
    url,
  ];
  const command =
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "google-chrome";
  const launchArgs = args;
  await new Promise((resolve, reject) => {
    const child = spawn(command, launchArgs, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
export async function connectProfile(selector, dependencies = {}) {
  const list = dependencies.profiles || profiles;
  const discover = dependencies.connections || connections;
  const call = dependencies.call || callBridge;
  const launch = dependencies.launch || launchProfile;
  const sleep =
    dependencies.sleep ||
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const profile = chooseProfile(await list(), selector);
  const find = async (nonce) => {
    const found = await Promise.all(
      (await discover()).map(async (connectionId) => {
        try {
          const identity = await call(
            connectionId,
            "browser_info",
            {},
            { timeout: 1500 },
          );
          if (
            identity.profile?.directory === profile.directory &&
            (!nonce || identity.profile.nonce === nonce)
          )
            return { connectionId, profile };
        } catch {
          /* Stale or unpaired connection. */
        }
      }),
    );
    const matches = found.filter(Boolean);
    if (matches.length > 1)
      throw new Error(
        "Several extension connections claim this profile. Disable duplicate extension builds and reconnect.",
      );
    return matches[0];
  };
  const connected = await find();
  if (connected) return connected;
  const manifest = JSON.parse(
    await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  );
  const extensionId = [
    ...createHash("sha256")
      .update(Buffer.from(manifest.key, "base64"))
      .digest()
      .subarray(0, 16),
  ]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
  const nonce = randomUUID();
  const fragment = new URLSearchParams({ profile: profile.directory, nonce });
  await launch(
    profile,
    `chrome-extension://${extensionId}/options.html#${fragment}`,
  );
  for (let i = 0; i < 20; i++) {
    const result = await find(nonce);
    if (result) return result;
    await sleep(500);
  }
  throw new Error(
    `Opened Chrome profile ${profile.name} (${profile.directory}). Load the extension's dist folder in this profile and enable Agent integration in Options, then retry. Website login and permissions remain specific to this profile.`,
  );
}
