import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { nativeFrame, decodeNative } from "./transport.mjs";
import { connections, callBridge } from "./client.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const hostPath = new URL("./native-host.mjs", import.meta.url).pathname;
const mcpPath = new URL("./mcp.mjs", import.meta.url).pathname;
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Fixture did not become ready");
}

test("native transport reassembles fragmented UTF-8 frames and rejects oversized messages", () => {
  const results = [];
  const decode = decodeNative((message) => results.push(message));
  const frame = nativeFrame({ text: "🍵 café" });
  for (const byte of frame) decode(Buffer.from([byte]));
  assert.deepEqual(results, [{ text: "🍵 café" }]);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(2000000);
  assert.throws(() => decodeNative(() => {})(oversized), /exceeds/);
});

test("MCP stdio to Unix socket to Chrome native framing works across concurrent calls and failures", async (t) => {
  const directory = await mkdtemp("/tmp/scraper-test-");
  const host = spawn(process.execPath, [hostPath], {
    env: { ...process.env, SCRAPER_BRIDGE_DIR: directory },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const sourceId = randomUUID(),
    jobId = randomUUID();
  const received = [];
  host.stdout.on(
    "data",
    decodeNative((message) => {
      received.push(message);
      const result =
        message.method === "list_tabs"
          ? [{ sourceId, title: "Test saved list", id: "google-maps" }]
          : message.method === "start_scrape"
            ? { jobId, state: "running" }
            : message.method === "get_results"
              ? {
                  items: [{ name: "Cafe", rating: 4.5 }],
                  complete: true,
                  nextOffset: null,
                }
              : message.method === "get_status"
                ? { state: "complete", complete: true }
                : { title: "Test saved list" };
      host.stdin.write(
        nativeFrame(
          message.method === "delete_job"
            ? { id: message.id, error: "Job not found" }
            : { id: message.id, result },
        ),
      );
    }),
  );
  let transport, client;
  t.after(async () => {
    await client?.close();
    host.stdin.end();
    if (host.exitCode === null) await once(host, "exit");
    await rm(directory, { recursive: true, force: true });
  });
  const ids = await until(async () => {
    const ids = await connections(directory);
    return ids.length ? ids : null;
  });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpPath],
    env: { ...process.env, SCRAPER_BRIDGE_DIR: directory },
  });
  client = new Client({ name: "integration-test", version: "1.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 15);
  assert.ok(tools.tools.some((tool) => tool.name === "get_voice_note"));
  const listed = JSON.parse(
    (
      await client.callTool({
        name: "list_tabs",
        arguments: { allProfiles: true },
      })
    ).content[0].text,
  );
  assert.equal(listed.browsers[0].tabs[0].sourceId, sourceId);
  const connectionId = listed.browsers[0].connectionId;
  const started = JSON.parse(
    (
      await client.callTool({
        name: "start_scrape",
        arguments: { connectionId, sourceId },
      })
    ).content[0].text,
  );
  assert.equal(started.jobId, jobId);
  const [status, results] = await Promise.all([
    client.callTool({ name: "get_status", arguments: { connectionId, jobId } }),
    client.callTool({
      name: "get_results",
      arguments: { connectionId, jobId },
    }),
  ]);
  assert.equal(JSON.parse(status.content[0].text).state, "complete");
  assert.equal(JSON.parse(results.content[0].text).items[0].name, "Cafe");
  const error = await client.callTool({
    name: "delete_job",
    arguments: { connectionId, jobId },
  });
  assert.equal(error.isError, true);
  assert.match(error.content[0].text, /not found/);
  await assert.rejects(
    callBridge("../outside", "list_tabs", {}, { directory }),
    /Invalid/,
  );
  assert.equal(received.length, 5);
});

test("installer pins the extension ID and installs an executable host without shell interpolation", async () => {
  const base = await mkdtemp("/tmp/scraper-install-");
  try {
    const child = spawn(
      process.execPath,
      [new URL("../scripts/setup-bridge.mjs", import.meta.url).pathname],
      { env: { ...process.env, SCRAPER_INSTALL_HOME: base } },
    );
    assert.equal((await once(child, "exit"))[0], 0);
    const { platform } = process;
    const prefix =
      platform === "darwin"
        ? "/Library/Application Support/Google/Chrome"
        : "/.config/google-chrome";
    const manifest = JSON.parse(
      await readFile(
        base +
          prefix +
          "/NativeMessagingHosts/org.scraper_extension.bridge.json",
      ),
    );
    assert.match(
      manifest.allowed_origins[0],
      /^chrome-extension:\/\/[a-p]{32}\/$/,
    );
    assert.equal(manifest.allowed_origins.length, 1);
    assert.match(await readFile(manifest.path, "utf8"), /^#!\/bin\/sh\nexec '/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
