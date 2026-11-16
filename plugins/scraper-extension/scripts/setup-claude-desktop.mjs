import { realpathSync } from "node:fs";
import {
  readFile,
  writeFile,
  mkdir,
  cp,
  access,
  rename,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function installClaudeDesktop({
  packageRoot,
  configPath,
  installDirectory,
  node = process.execPath,
  profile,
} = {}) {
  await access(join(packageRoot, "bridge/mcp.mjs"));
  // Parse before changing files: malformed existing settings must never be overwritten.
  let config = {},
    original;
  try {
    original = await readFile(configPath, "utf8");
    config = JSON.parse(original);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    (config.mcpServers &&
      (typeof config.mcpServers !== "object" ||
        Array.isArray(config.mcpServers)))
  )
    throw new Error(
      "Claude desktop config must contain an object and an optional mcpServers object.",
    );
  await mkdir(installDirectory, { recursive: true, mode: 0o700 });
  for (const directory of ["bridge", "scripts", "extension"])
    await cp(join(packageRoot, directory), join(installDirectory, directory), {
      recursive: true,
    });
  await cp(
    join(packageRoot, "manifest.json"),
    join(installDirectory, "manifest.json"),
  );
  const previous = config.mcpServers?.["scraper-extension"];
  const env = { ...(previous?.env || {}) };
  if (profile) env.SCRAPER_CHROME_PROFILE = profile;
  config.mcpServers = {
    ...config.mcpServers,
    "scraper-extension": {
      command: node,
      args: [join(installDirectory, "bridge/mcp.mjs")],
      ...(Object.keys(env).length ? { env } : {}),
    },
  };
  await mkdir(dirname(configPath), { recursive: true });
  if (original !== undefined)
    await writeFile(configPath + ".scraper-backup-" + Date.now(), original, {
      mode: 0o600,
    });
  const temporary = configPath + ".scraper-" + process.pid + ".tmp";
  await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temporary, configPath);
  return { configPath, installDirectory };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const packageRoot = await access(join(root, "extension")).then(
    () => root,
    () => join(root, "plugins/scraper-extension"),
  );
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("The browser bridge currently supports macOS and Linux.");
  const base = process.env.SCRAPER_INSTALL_HOME || homedir();
  const configPath =
    process.platform === "darwin"
      ? join(
          base,
          "Library/Application Support/Claude/claude_desktop_config.json",
        )
      : join(base, ".config/Claude/claude_desktop_config.json");
  const result = await installClaudeDesktop({
    packageRoot,
    configPath,
    installDirectory: join(
      base,
      ".local/share/scraper-extension/claude-desktop",
    ),
    profile: process.argv[2] || process.env.SCRAPER_CHROME_PROFILE,
  });
  console.log(`Claude desktop configured: ${result.configPath}`);
  console.log(
    `Run node "${join(result.installDirectory, "scripts/setup-bridge.mjs")}" once, load "${join(result.installDirectory, "extension")}" in Chrome, and restart Claude desktop.`,
  );
}
