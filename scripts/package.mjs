import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { zipSync } from "fflate";
const files = {};
for (const name of await readdir("dist"))
  files[name] = new Uint8Array(await readFile("dist/" + name));
await mkdir("artifacts", { recursive: true });
await writeFile("artifacts/scraper-extension.zip", zipSync(files));
console.log("Created artifacts/scraper-extension.zip");
