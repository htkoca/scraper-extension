import { build } from "esbuild";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
const root = "plugins/scraper-extension";
await rm(root, { recursive: true, force: true });
for (const dir of ["bridge", "scripts", "extension", ".codex-plugin"])
  await mkdir(join(root, dir), { recursive: true });
await build({
  entryPoints: ["bridge/mcp.mjs"],
  outfile: join(root, "bridge/mcp.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "eof",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
for (const file of ["native-host.mjs", "transport.mjs"])
  await copyFile("bridge/" + file, join(root, "bridge", file));
await copyFile(
  "scripts/setup-bridge.mjs",
  join(root, "scripts/setup-bridge.mjs"),
);
await copyFile("manifest.json", join(root, "manifest.json"));
for (const file of await readdir("dist"))
  await copyFile(join("dist", file), join(root, "extension", file));
const manifest = JSON.parse(
  await readFile("plugin-metadata/plugin.json", "utf8"),
);
await writeFile(
  join(root, "plugin.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
const server = {
  type: "stdio",
  command: "node",
  args: ["${PLUGIN_ROOT}/bridge/mcp.mjs"],
  cwd: "${PLUGIN_ROOT}",
};
await writeFile(
  join(root, "mcp.json"),
  JSON.stringify(
    {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { scraper: server },
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  join(root, ".mcp.json"),
  JSON.stringify(
    {
      mcpServers: {
        scraper: {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/bridge/mcp.mjs"],
          cwd: "${CLAUDE_PLUGIN_ROOT}",
        },
      },
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  join(root, ".codex-plugin/plugin.json"),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      mcpServers: "./.mcp.json",
      interface: manifest.extensions["com.openai"].interface,
    },
    null,
    2,
  ) + "\n",
);
let notices =
  "Third-party licenses for the bundled MCP server and Chrome extension.\n";
async function licenses(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.name.startsWith("@")) {
      await licenses(path);
      continue;
    }
    const files = await readdir(path);
    for (const file of files.filter((name) =>
      /^licen[sc]e(?:\..*)?$/i.test(name),
    )) {
      notices +=
        `\n--- ${entry.name} ---\n` +
        (await readFile(join(path, file), "utf8")) +
        "\n";
    }
  }
}
await licenses("node_modules");
await writeFile(join(root, "THIRD-PARTY-LICENSES.txt"), notices);
await writeFile(
  join(root, "README.md"),
  `# Scraper Extension\n\nRequires Node.js 22+ and Google Chrome on macOS or Linux.\n\nRun \`node scripts/setup-bridge.mjs\` from this plugin folder. In Chrome's extensions page, enable Developer mode and load this folder's \`extension\` directory. Enable website access and Codex integration in the extension's Options.\n\nRestart ChatGPT desktop and start a new chat with this plugin. Ask it to connect to your preferred Chrome profile, then name the service and source to collect. Profile preferences belong in local MCP configuration using SCRAPER_CHROME_PROFILE.\n\nResults remain in browser memory until the extension restarts and are sent to the calling agent on request. Chrome login and optional site access are required. No browser credentials are copied to the MCP server.\n\nMaps name discovery may require a saved-list URL. New website adapters have automated fixture coverage but still need live signed-in verification. This package is distributed through a GitHub marketplace, not the reviewed OpenAI directory.\n`,
);
console.log("Plugin packaged at " + root);
