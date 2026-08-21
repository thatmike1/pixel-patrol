/**
 * tests for the drift diff.
 *
 * these cover the part of the system a model is never allowed to get wrong: if
 * a host appears and the diff misses it, the whole product silently reports
 * "nothing changed" on the exact event it exists to catch.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { diffFingerprints } from "./diff.js";
import type { Fingerprint, FingerprintCookie, FingerprintHost } from "./types.js";

/** a host entry with sane defaults, overridable per test */
function host(name: string, overrides: Partial<FingerprintHost> = {}): FingerprintHost {
  return {
    host: name,
    vendor: null,
    category: "unclassified",
    type: "script",
    ...overrides,
  };
}

/** a cookie entry with sane defaults, overridable per test */
function cookie(
  name: string,
  domain: string,
  overrides: Partial<FingerprintCookie> = {},
): FingerprintCookie {
  return {
    name,
    domain,
    path: "/",
    category: "unclassified",
    isFirstParty: false,
    durationSeconds: null,
    ...overrides,
  };
}

/** a fingerprint built from just the fields the diff reads */
function fingerprint(
  sweepId: string,
  hosts: FingerprintHost[],
  cookies: FingerprintCookie[],
  hash: string,
): Fingerprint {
  return {
    siteId: "smoke",
    sweepId,
    siteUrl: "https://example.test",
    scannedAt: "2026-08-21T18:00:00.000Z",
    pagesScanned: 5,
    hosts,
    cookies,
    preConsentNonNecessaryCount: 0,
    complianceScore: 100,
    hash,
  };
}

test("identical fingerprints produce an empty diff", () => {
  const hosts = [host("www.googletagmanager.com")];
  const cookies = [cookie("_ga", ".example.test")];
  const a = fingerprint("one", hosts, cookies, "hash-a");
  const b = fingerprint("two", hosts, cookies, "hash-a");

  const diff = diffFingerprints(b, a, "baseline");

  assert.equal(diff.comparedTo, "baseline");
  assert.deepEqual(diff.hostsAdded, []);
  assert.deepEqual(diff.hostsRemoved, []);
  assert.deepEqual(diff.cookiesAdded, []);
  assert.deepEqual(diff.cookiesRemoved, []);
  assert.equal(diff.hashChanged, false);
});

test("a new tracker host is reported as added with its vendor and category", () => {
  const before = fingerprint("one", [host("www.googletagmanager.com")], [], "hash-a");
  const after = fingerprint(
    "two",
    [
      host("connect.facebook.net", { vendor: "Meta Pixel", category: "marketing" }),
      host("www.googletagmanager.com"),
    ],
    [],
    "hash-b",
  );

  const diff = diffFingerprints(after, before, "baseline");

  assert.deepEqual(diff.hostsAdded, [
    { host: "connect.facebook.net", vendor: "Meta Pixel", category: "marketing" },
  ]);
  assert.deepEqual(diff.hostsRemoved, []);
  assert.equal(diff.hashChanged, true);
});

test("a host that disappears is reported as removed", () => {
  const before = fingerprint("one", [host("a.test"), host("b.test")], [], "hash-a");
  const after = fingerprint("two", [host("a.test")], [], "hash-b");

  const diff = diffFingerprints(after, before, "previous");

  assert.deepEqual(diff.hostsAdded, []);
  assert.deepEqual(diff.hostsRemoved.map((entry) => entry.host), ["b.test"]);
  assert.equal(diff.comparedTo, "previous");
});

test("cookies are identified by name and domain together", () => {
  // the same cookie name on a different domain is a different cookie: one is
  // the site's own, the other is a third party's
  const before = fingerprint("one", [], [cookie("sid", "example.test")], "hash-a");
  const after = fingerprint("two", [], [cookie("sid", "tracker.test")], "hash-b");

  const diff = diffFingerprints(after, before, "baseline");

  assert.deepEqual(diff.cookiesAdded, [
    { name: "sid", domain: "tracker.test", category: "unclassified" },
  ]);
  assert.deepEqual(diff.cookiesRemoved, [
    { name: "sid", domain: "example.test", category: "unclassified" },
  ]);
});

test("hashChanged is independent of the delta lists", () => {
  // the crawler's hash covers host names and cookie identities only, so a
  // fingerprint whose cookie durations moved has a different document but the
  // same hash and no deltas
  const hosts = [host("a.test")];
  const before = fingerprint("one", hosts, [cookie("_ga", "a.test")], "hash-a");
  const after = fingerprint(
    "two",
    hosts,
    [cookie("_ga", "a.test", { durationSeconds: 60 })],
    "hash-a",
  );

  const diff = diffFingerprints(after, before, "baseline");

  assert.equal(diff.hashChanged, false);
  assert.deepEqual(diff.cookiesAdded, []);
  assert.deepEqual(diff.cookiesRemoved, []);
});

test("with nothing to compare against the diff is empty and comparedTo is none", () => {
  const only = fingerprint("one", [host("a.test")], [cookie("_ga", "a.test")], "hash-a");

  const diff = diffFingerprints(only, null, "baseline");

  assert.equal(diff.comparedTo, "none");
  assert.deepEqual(diff.hostsAdded, []);
  assert.deepEqual(diff.cookiesAdded, []);
  assert.equal(diff.hashChanged, false);
});
