import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp.mjs";

test("list_tabs uses an explicitly selected browser without requiring a configured default", async () => {
  const calls = [];
  const server = createMcpServer({
    connect: async () => {
      throw new Error("No default");
    },
    call: async (...args) => {
      calls.push(args);
      return [];
    },
  });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const result = await client.callTool({
      name: "list_tabs",
      arguments: { connectionId: "chosen-browser" },
    });
    assert.notEqual(result.isError, true);
    assert.equal(calls[0][0], "chosen-browser");
    assert.equal(calls[0][1], "list_tabs");
    const invalid = await client.callTool({
      name: "list_tabs",
      arguments: { connectionId: "chosen-browser", allProfiles: true },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
