import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { installClaudeDesktop } from "../scripts/setup-claude-desktop.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("Claude desktop installation preserves settings and starts the standalone MCP runtime", async () => {
  const dir = await mkdtemp("/tmp/scraper-client-");
  const configPath = join(dir, "claude_desktop_config.json");
  const original = {
    preferences: { theme: "dark" },
    mcpServers: {
      other: { command: "example" },
      "scraper-extension": { env: { SCRAPER_CHROME_PROFILE: "Personal" } },
    },
  };
  await writeFile(configPath, JSON.stringify(original));
  const client = new Client({ name: "claude-config-check", version: "1.0.0" });
  try {
    const result = await installClaudeDesktop({
      packageRoot: resolve("plugins/scraper-extension"),
      configPath,
      installDirectory: join(dir, "runtime"),
    });
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(config.preferences, original.preferences);
    assert.deepEqual(config.mcpServers.other, original.mcpServers.other);
    const server = config.mcpServers["scraper-extension"];
    assert.equal(server.env.SCRAPER_CHROME_PROFILE, "Personal");
    assert.equal(server.command, process.execPath);
    assert.ok(
      (await readdir(dir)).some((name) =>
        name.startsWith("claude_desktop_config.json.scraper-backup-"),
      ),
    );
    await client.connect(new StdioClientTransport(server));
    assert.equal((await client.listTools()).tools.length, 14);
    assert.equal(
      (
        await client.callTool({
          name: "list_tabs",
          arguments: { allProfiles: true },
        })
      ).isError,
      undefined,
    );
    await installClaudeDesktop({
      packageRoot: resolve("plugins/scraper-extension"),
      configPath,
      installDirectory: result.installDirectory,
      profile: "Different profile",
    });
    assert.equal(
      JSON.parse(await readFile(configPath, "utf8")).mcpServers[
        "scraper-extension"
      ].env.SCRAPER_CHROME_PROFILE,
      "Different profile",
    );
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed Claude settings are preserved and never overwritten", async () => {
  const dir = await mkdtemp("/tmp/scraper-client-");
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, "invalid json");
    await assert.rejects(
      installClaudeDesktop({
        packageRoot: resolve("plugins/scraper-extension"),
        configPath,
        installDirectory: join(dir, "runtime"),
      }),
    );
    assert.equal(await readFile(configPath, "utf8"), "invalid json");
    assert.deepEqual(await readdir(dir), ["config.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude and OpenAI manifests describe the same version and bundled runtime", async () => {
  const root = "plugins/scraper-extension/";
  const read = async (file) => JSON.parse(await readFile(root + file, "utf8"));
  const portable = await read("plugin.json");
  for (const file of [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
  ]) {
    const manifest = await read(file);
    assert.equal(manifest.name, portable.name);
    assert.equal(manifest.version, portable.version);
  }
  assert.deepEqual((await read(".mcp.json")).mcpServers.scraper.args, [
    "${CLAUDE_PLUGIN_ROOT}/bridge/mcp.mjs",
  ]);
  assert.deepEqual((await read("mcp.json")).mcpServers.scraper.args, [
    "${PLUGIN_ROOT}/bridge/mcp.mjs",
  ]);
});
