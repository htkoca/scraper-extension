import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const routes = {
  "/": "dev/demo.html",
  "/app.js": "dist/app.js",
  "/app.css": "dist/app.css",
  "/fixture.js": "dev/fixture.js",
};
createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (!routes[pathname]) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const data = await readFile(routes[pathname]);
    res.setHeader(
      "Content-Type",
      pathname.endsWith(".js")
        ? "text/javascript"
        : pathname.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    res.end(data);
  } catch {
    res.writeHead(500);
    res.end("Build first.");
  }
}).listen(4318, "127.0.0.1", () =>
  console.log("Fixture preview: http://127.0.0.1:4318"),
);
