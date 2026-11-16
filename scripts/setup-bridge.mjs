import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  chmod,
  access,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostName } from "../bridge/transport.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(join(root, "manifest.json"), "utf8"),
);
const extensionId = [
  ...createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest()
    .subarray(0, 16),
]
  .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
  .join("");
const base = process.env.SCRAPER_INSTALL_HOME || homedir();
const installDir = join(base, ".local", "share", "scraper-extension");
const browserDir =
  process.platform === "darwin"
    ? join(
        base,
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "NativeMessagingHosts",
      )
    : process.platform === "linux"
      ? join(base, ".config", "google-chrome", "NativeMessagingHosts")
      : null;
if (!browserDir)
  throw new Error("Native host installer supports macOS and Linux Chrome.");
await mkdir(installDir, { recursive: true, mode: 0o700 });
await mkdir(browserDir, { recursive: true });
for (const file of ["native-host.mjs", "transport.mjs"])
  await copyFile(join(root, "bridge", file), join(installDir, file));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const launcher = join(installDir, "native-host");
await writeFile(
  launcher,
  `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(installDir, "native-host.mjs"))} "$@"\n`,
  { mode: 0o700 },
);
await chmod(launcher, 0o700);
await writeFile(
  join(browserDir, hostName + ".json"),
  JSON.stringify(
    {
      name: hostName,
      description: "Scraper Extension local agent bridge",
      path: launcher,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    },
    null,
    2,
  ) + "\n",
);
console.log(`Native host installed for Chrome. Extension ID: ${extensionId}`);
const extensionDir = await access(join(root, "extension")).then(
  () => "extension",
  () => "dist",
);
console.log(
  `Load ${join(root, extensionDir)} in Chrome, then open extension options to enable websites and agent access.`,
);
console.log(
  "Use the ChatGPT/Codex or Claude Code plugin, or configure a standalone MCP connection:",
);
console.log(
  `Codex: codex mcp add scraper-extension -- ${quote(process.execPath)} ${quote(join(root, "bridge", "mcp.mjs"))}`,
);
console.log(
  `Claude Code: claude mcp add --transport stdio --scope user scraper-extension -- ${quote(process.execPath)} ${quote(join(root, "bridge", "mcp.mjs"))}`,
);
console.log(
  `Claude desktop: node ${quote(join(root, "scripts", "setup-claude-desktop.mjs"))}`,
);
