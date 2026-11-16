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
