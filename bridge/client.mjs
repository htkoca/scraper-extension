import net from "node:net";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  runtimeDirectory,
  privateDirectory,
  decodeLines,
} from "./transport.mjs";

export async function connections(directory = runtimeDirectory()) {
  await privateDirectory(directory);
  return (await readdir(directory))
    .filter((name) => /^[a-f\d-]+\.sock$/.test(name))
    .map((name) => name.slice(0, -5));
}
export async function callBridge(
  connectionId,
  method,
  params = {},
  { directory = runtimeDirectory(), timeout = 40000 } = {},
) {
  if (!/^[a-f\d-]+$/.test(connectionId))
    throw new Error("Invalid browser connection ID.");
  await privateDirectory(directory);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(
      join(directory, `${connectionId}.sock`),
    );
    const id = randomUUID();
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Browser bridge timed out. Reconnect it in extension options.",
          ),
        ),
      timeout,
    );
    let settled = false;
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }
    socket.setEncoding("utf8");
    socket.once("connect", () =>
      socket.write(JSON.stringify({ id, method, params }) + "\n"),
    );
    const decode = decodeLines((message) => {
      if (message.id !== id) return;
      finish(message.error ? new Error(message.error) : null, message.result);
    });
    socket.on("data", (chunk) => {
      try {
        decode(chunk);
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () =>
      finish(new Error("Browser disconnected before replying.")),
    );
  });
}
