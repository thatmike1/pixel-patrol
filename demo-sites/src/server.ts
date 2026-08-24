/**
 * the demo target: a static file server over `public/`, and nothing else.
 *
 * no framework and no dependencies, because every byte this service serves is
 * evidence. the watchdog's claim is that the third-party hosts it fingerprints
 * are the ones the page asks for, so the thing serving the page should be small
 * enough to read in one sitting and incapable of adding a request of its own.
 *
 * `Cache-Control: no-store` on every response for the same reason: a demo run
 * edits a page and redeploys, and a cached copy anywhere between here and the
 * crawler would show the watchdog the version before the edit — which reads,
 * from the outside, exactly like a watchdog that missed a change.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTENT_TYPES, resolveFile } from "./static-files.js";

/** the directory the pages are served from */
const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

/**
 * serves one request.
 *
 * @param req the request
 * @param res the response
 */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/healthz" || url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    return;
  }

  const file = resolveFile(PUBLIC_DIR, url.pathname);
  if (!file) {
    res.writeHead(400, { "content-type": "text/plain" }).end("bad path\n");
    return;
  }

  // a bare /boutique is the URL a human types; redirect rather than serve, so
  // the crawler only ever fingerprints one canonical URL per demo site
  let isDirectory = false;
  try {
    isDirectory = (await stat(file)).isDirectory();
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
    return;
  }
  if (isDirectory) {
    res.writeHead(302, { location: `${url.pathname}/` }).end();
    return;
  }

  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
}

const port = Number(process.env.PORT ?? 8080);
createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("error\n");
  });
}).listen(port, () => {
  process.stdout.write(`demo-sites listening on ${port}, serving ${PUBLIC_DIR}\n`);
});
