import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, lstat, chmod } from "node:fs/promises";

export const hostName = "org.scraper_extension.bridge";
export const runtimeDirectory = () =>
  process.env.SCRAPER_BRIDGE_DIR ||
  join(homedir(), ".local", "state", "scraper-extension");
export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid()
  )
    throw new Error(
      "Bridge directory must be a real directory owned by the current user.",
    );
  await chmod(directory, 0o700);
}
export function nativeFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > 900000)
    throw new Error("Bridge response too large. Request fewer results.");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
export function decodeNative(onMessage) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readUInt32LE(0);
      if (length > 1048576) throw new Error("Native message exceeds 1 MiB.");
      if (pending.length < length + 4) break;
      const message = JSON.parse(pending.subarray(4, 4 + length).toString());
      pending = pending.subarray(4 + length);
      onMessage(message);
    }
  };
}
export function decodeLines(onMessage) {
  let pending = "";
  return (chunk) => {
    pending += chunk;
    if (Buffer.byteLength(pending) > 1048576)
      throw new Error("Socket message exceeds 1 MiB.");
    let index;
    while ((index = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (line) onMessage(JSON.parse(line));
    }
  };
}
