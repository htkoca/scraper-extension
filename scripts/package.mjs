import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { zipSync } from "fflate";
const files = {};
for (const name of await readdir("dist"))
  files[name] = new Uint8Array(await readFile("dist/" + name));
await mkdir("artifacts", { recursive: true });
await writeFile("artifacts/ig-dm-archive.zip", zipSync(files));
console.log("Created artifacts/ig-dm-archive.zip");
