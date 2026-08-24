/**
 * tests for the path mapping. the containment rule is the whole security
 * surface of this service, and the property worth pinning is not "traversal
 * returns null" but "nothing outside `public/` is ever named" — a request path
 * always starts at the root, so `..` is normalized away rather than rejected,
 * and a test written against the rejection would pass for the wrong reason.
 */

import assert from "node:assert/strict";
import { sep } from "node:path";
import { test } from "node:test";

import { resolveFile } from "./static-files.js";

const ROOT = "/srv/public";

/** every path this maps to is inside the root, or is refused outright */
function contained(urlPath: string): void {
  const file = resolveFile(ROOT, urlPath);
  if (file === null) return;
  assert.ok(
    file === ROOT || file.startsWith(ROOT + sep),
    `${urlPath} escaped the root as ${file}`,
  );
}

test("a directory path is served by its index", () => {
  assert.equal(resolveFile(ROOT, "/boutique/"), "/srv/public/boutique/index.html");
  assert.equal(resolveFile(ROOT, "/"), "/srv/public/index.html");
});

test("a file path maps straight through", () => {
  assert.equal(resolveFile(ROOT, "/assets/site.css"), "/srv/public/assets/site.css");
});

test("traversal cannot name a file outside the root", () => {
  contained("/../secrets.txt");
  contained("/boutique/../../secrets.txt");
  contained("/../../../../etc/passwd");
  // and the collapsed path is the one inside the root, not a sibling of it
  assert.equal(resolveFile(ROOT, "/../secrets.txt"), "/srv/public/secrets.txt");
});

test("percent-encoded traversal cannot either", () => {
  // the check runs on the resolved path, so an encoded `..` is decoded and
  // normalized before it is judged rather than inspected as text
  contained("/%2e%2e/secrets.txt");
  contained("/%2e%2e%2f%2e%2e%2fsecrets.txt");
  contained("/boutique/%2e%2e%2f%2e%2e%2fetc%2fpasswd");
});

test("undecodable and nul-bearing paths are refused", () => {
  assert.equal(resolveFile(ROOT, "/%"), null);
  assert.equal(resolveFile(ROOT, "/a%00.html"), null);
});
