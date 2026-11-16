import net from "node:net";
import { randomUUID } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  runtimeDirectory,
  privateDirectory,
  nativeFrame,
  decodeNative,
  decodeLines,
} from "./transport.mjs";

process.umask(0o077);
const directory = runtimeDirectory();
await privateDirectory(directory);
const socketPath = join(directory, `${randomUUID()}.sock`);
const pending = new Map();
const sockets = new Set();
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.setEncoding("utf8");
  const decode = decodeLines((message) => {
    if (typeof message.id !== "string" || typeof message.method !== "string")
      throw new Error("Invalid bridge request.");
    const id = randomUUID();
    pending.set(id, { socket, originalId: message.id });
    process.stdout.write(nativeFrame({ ...message, id }));
  });
  socket.on("data", (data) => {
    try {
      decode(data);
    } catch {
      socket.destroy();
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    sockets.delete(socket);
    for (const [id, request] of pending)
      if (request.socket === socket) pending.delete(id);
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(socketPath, resolve);
});
await chmod(socketPath, 0o600);
const decode = decodeNative((message) => {
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  request.socket.end(
    JSON.stringify({ ...message, id: request.originalId }) + "\n",
  );
});
process.stdin.on("data", (chunk) => {
  try {
    decode(chunk);
  } catch {
    shutdown();
  }
});
process.stdin.on("end", shutdown);
process.stdin.on("error", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  for (const socket of sockets) socket.destroy();
  server.close();
  await unlink(socketPath).catch(() => {});
  process.exit(0);
}
