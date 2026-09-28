import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { handleApiRequest } from "./lib/api-handler.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(readFileSync(join(here, "public", "index.html")));
    return;
  }

  if (req.method === "GET" && url.pathname === "/style.css") {
    res.writeHead(200, {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(readFileSync(join(here, "public", "style.css")));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    await handleApiRequest(req, res);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(port, host, () => {
  console.log(`Local API client: http://${host}:${port}`);
  console.log(
    `Client certificate configured: ${Boolean(
      process.env.PFX_BASE64 || process.env.PFX_PATH
    )}`
  );
});