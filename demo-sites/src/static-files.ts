/**
 * mapping a request path to a file under `public/`.
 *
 * separated from the server so it can be tested without binding a port: the
 * containment rule is the only part of this service with a way to be wrong, and
 * the process it runs in can read the whole container image.
 */

import { join, normalize, resolve, sep } from "node:path";

/** the only content types these pages need */
export const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * maps a request path to a file inside a root directory, or null when it
 * escapes.
 *
 * the containment check is on the resolved path rather than on the URL text: a
 * percent-encoded `..` survives string inspection and does not survive
 * `path.normalize`.
 *
 * @param root the absolute directory files may come from
 * @param urlPath the request's pathname
 * @returns the absolute file path, or null when it is outside `root`
 */
export function resolveFile(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  // a directory is served by its index, which is what makes /boutique/ a page
  const relative = decoded.endsWith("/") ? `${decoded}index.html` : decoded;
  const candidate = resolve(join(root, normalize(relative)));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}
