import { build } from "esbuild";
import { mkdir, rm, copyFile } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/app.js", "src/background.js"],
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "chrome120",
  legalComments: "eof",
});
for (const [source, dest] of [
  ["manifest.json", "manifest.json"],
  ["src/app.html", "app.html"],
  ["src/app.css", "app.css"],
])
  await copyFile(source, "dist/" + dest);
await copyFile("node_modules/fflate/LICENSE", "dist/THIRD-PARTY-LICENSE.txt");
console.log("Extension ready in dist/");
