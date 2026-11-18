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

test("MCP exposes bounded voice-note offsets and forwards chunks to the selected browser", async () => {
  const calls = [];
  const server = createMcpServer({
    call: async (...args) => {
      calls.push(args);
      return { data: "YQ==", nextOffset: null };
    },
  });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const args = {
      connectionId: "selected",
      jobId: "00000000-0000-4000-8000-000000000001",
      messageId: "voice-1",
      offset: 196608,
    };
    const result = await client.callTool({
      name: "get_voice_note",
      arguments: args,
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls[0], [
      "selected",
      "get_voice_note",
      { jobId: args.jobId, messageId: args.messageId, offset: args.offset },
    ]);
    const invalid = await client.callTool({
      name: "get_voice_note",
      arguments: { ...args, offset: -1 },
    });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});
