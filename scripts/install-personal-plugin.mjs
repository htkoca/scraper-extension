import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cp, readFile, writeFile, mkdir } from "node:fs/promises";
const base = homedir();
const destination = join(base, ".codex/plugins/scraper-extension");
await mkdir(destination, { recursive: true });
await cp(resolve("plugins/scraper-extension"), destination, {
  recursive: true,
});
const profile = process.argv[2] || process.env.SCRAPER_CHROME_PROFILE;
for (const file of ["mcp.json", ".mcp.json"]) {
  const path = join(destination, file),
    config = JSON.parse(await readFile(path, "utf8"));
  if (profile)
    config.mcpServers.scraper.env = { SCRAPER_CHROME_PROFILE: profile };
  await writeFile(path, JSON.stringify(config, null, 2) + "\n");
}
const path = join(base, ".agents/plugins/marketplace.json");
await mkdir(join(base, ".agents/plugins"), { recursive: true });
let marketplace;
try {
  marketplace = JSON.parse(await readFile(path, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  marketplace = {
    name: "personal-local",
    interface: { displayName: "Personal local" },
    plugins: [],
  };
}
marketplace.plugins = marketplace.plugins.filter(
  (plugin) => plugin.name !== "scraper-extension",
);
marketplace.plugins.push({
  name: "scraper-extension",
  source: { source: "local", path: "./.codex/plugins/scraper-extension" },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  category: "Productivity",
});
await writeFile(path, JSON.stringify(marketplace, null, 2) + "\n");
console.log(
  `Personal marketplace updated. Install scraper-extension@${marketplace.name}.`,
);

// The same personal package is available to Claude Code through its native catalog.
const claudePath = join(base, ".claude-plugin/marketplace.json");
await mkdir(join(base, ".claude-plugin"), { recursive: true });
let claudeMarketplace;
try {
  claudeMarketplace = JSON.parse(await readFile(claudePath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  claudeMarketplace = {
    name: "scraper-personal",
    owner: { name: "Scraper Extension" },
    plugins: [],
  };
}
claudeMarketplace.plugins = claudeMarketplace.plugins.filter(
  (plugin) => plugin.name !== "scraper-extension",
);
claudeMarketplace.plugins.push({
  name: "scraper-extension",
  source: "./.codex/plugins/scraper-extension",
});
await writeFile(claudePath, JSON.stringify(claudeMarketplace, null, 2) + "\n");
console.log(
  `Claude Code personal catalog ready: claude plugin marketplace add "${base}"`,
);
console.log(`Then install scraper-extension@${claudeMarketplace.name}.`);
