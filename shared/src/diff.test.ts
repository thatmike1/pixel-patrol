/**
 * tests for the drift diff.
 *
 * these cover the part of the system a model is never allowed to get wrong: if
 * a tracker appears and the diff misses it, the whole product silently reports
 * "nothing changed" on the exact event it exists to catch. the CDN-rotation
 * cases cover the opposite failure, which is nearly as bad — an alert on every
 * sweep trains the owner to ignore all of them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { diffFingerprints, isIncompatible } from "./diff.js";
import type { FingerprintDiff } from "./diff.js";
import type { Fingerprint, FingerprintCookie, FingerprintHost } from "./fingerprint.js";

/** a host entry with sane defaults, overridable per test */
function host(
  name: string,
  registrableDomain: string,
  overrides: Partial<FingerprintHost> = {},
): FingerprintHost {
  return {
    host: name,
    registrableDomain,
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

/** a generation 2 fingerprint built from just the fields the diff reads */
function fingerprint(
  sweepId: string,
  hosts: FingerprintHost[],
  cookies: FingerprintCookie[],
  hash: string,
  overrides: Partial<Fingerprint> = {},
): Fingerprint {
  return {
    schemaVersion: 2,
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
    ...overrides,
  };
}

/** asserts a result is a real diff and narrows it, failing loudly if not */
function asDiff(result: ReturnType<typeof diffFingerprints>): FingerprintDiff {
  assert.ok(!isIncompatible(result), `expected a diff, got: ${JSON.stringify(result)}`);
  return result;
}

const gtm = host("www.googletagmanager.com", "googletagmanager.com", {
  vendor: "Google Tag Manager",
  category: "analytics",
});

test("identical fingerprints produce an empty diff", () => {
  const hosts = [gtm];
  const cookies = [cookie("_ga", ".example.test")];
  const before = fingerprint("one", hosts, cookies, "hash-a");
  const after = fingerprint("two", hosts, cookies, "hash-a");

  const diff = asDiff(diffFingerprints(after, before, "baseline"));

  assert.equal(diff.comparedTo, "baseline");
  assert.deepEqual(diff.hostsAdded, []);
  assert.deepEqual(diff.hostsRemoved, []);
  assert.deepEqual(diff.cookiesAdded, []);
  assert.deepEqual(diff.cookiesRemoved, []);
  assert.equal(diff.hashChanged, false);
});

test("a new tracker domain is reported with its vendor and an example host", () => {
  const before = fingerprint("one", [gtm], [], "hash-a");
  const after = fingerprint(
    "two",
    [
      host("connect.facebook.net", "facebook.net", {
        vendor: "Meta Pixel",
        category: "marketing",
      }),
      gtm,
    ],
    [],
    "hash-b",
  );

  const diff = asDiff(diffFingerprints(after, before, "baseline"));

  assert.deepEqual(diff.hostsAdded, [
    {
      registrableDomain: "facebook.net",
      host: "connect.facebook.net",
      vendor: "Meta Pixel",
      category: "marketing",
    },
  ]);
  assert.deepEqual(diff.hostsRemoved, []);
  assert.equal(diff.hashChanged, true);
});

test("rotating CDN shards under one registrable domain are not drift", () => {
  // the whole reason hosts are keyed by eTLD+1: these hostnames change between
  // sweeps by design, and reporting them would fire an alert every single time
  const before = fingerprint(
    "one",
    [host("d15-a.sdn.cz", "sdn.cz"), host("d21-a.sdn.cz", "sdn.cz")],
    [],
    "hash-a",
  );
  const after = fingerprint(
    "two",
    [host("d02-a.sdn.cz", "sdn.cz"), host("d44-a.sdn.cz", "sdn.cz")],
    [],
    "hash-b",
  );

  const diff = asDiff(diffFingerprints(after, before, "previous"));

  assert.deepEqual(diff.hostsAdded, []);
  assert.deepEqual(diff.hostsRemoved, []);
  // the hash still moved, because the crawler hashes hostnames
  assert.equal(diff.hashChanged, true);
});

test("a genuinely new domain is still caught alongside shard rotation", () => {
  const before = fingerprint("one", [host("d15-a.sdn.cz", "sdn.cz")], [], "hash-a");
  const after = fingerprint(
    "two",
    [
      host("connect.facebook.net", "facebook.net", {
        vendor: "Meta Pixel",
        category: "marketing",
      }),
      host("d44-a.sdn.cz", "sdn.cz"),
    ],
    [],
    "hash-b",
  );

  const diff = asDiff(diffFingerprints(after, before, "baseline"));

  assert.deepEqual(diff.hostsAdded.map((entry) => entry.registrableDomain), ["facebook.net"]);
  assert.deepEqual(diff.hostsRemoved, []);
});

test("the representative host for a domain prefers the attributed member", () => {
  // across a sharded group only some entries carry a vendor; naming the
  // attributed one tells the model more than an arbitrary shard does
  const before = fingerprint("one", [], [], "hash-a");
  const after = fingerprint(
    "two",
    [
      host("a1.tracker.test", "tracker.test"),
      host("pixel.tracker.test", "tracker.test", {
        vendor: "Some Tracker",
        category: "marketing",
      }),
      host("a2.tracker.test", "tracker.test"),
    ],
    [],
    "hash-b",
  );

  const diff = asDiff(diffFingerprints(after, before, "baseline"));

  assert.deepEqual(diff.hostsAdded, [
    {
      registrableDomain: "tracker.test",
      host: "pixel.tracker.test",
      vendor: "Some Tracker",
      category: "marketing",
    },
  ]);
});

test("a domain that disappears entirely is reported as removed", () => {
  const before = fingerprint(
    "one",
    [host("a.test", "a.test"), host("b.test", "b.test")],
    [],
    "hash-a",
  );
  const after = fingerprint("two", [host("a.test", "a.test")], [], "hash-b");

  const diff = asDiff(diffFingerprints(after, before, "previous"));

  assert.deepEqual(diff.hostsAdded, []);
  assert.deepEqual(diff.hostsRemoved.map((entry) => entry.registrableDomain), ["b.test"]);
  assert.equal(diff.comparedTo, "previous");
});

test("cookies are identified by name and domain together", () => {
  // the same cookie name on a different domain is a different cookie: one is
  // the site's own, the other is a third party's
  const before = fingerprint("one", [], [cookie("sid", "example.test")], "hash-a");
  const after = fingerprint("two", [], [cookie("sid", "tracker.test")], "hash-b");

  const diff = asDiff(diffFingerprints(after, before, "baseline"));

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
  const hosts = [host("a.test", "a.test")];
  const before = fingerprint("one", hosts, [cookie("_ga", "a.test")], "hash-a");
  const after = fingerprint(
    "two",
    hosts,
    [cookie("_ga", "a.test", { durationSeconds: 60 })],
    "hash-a",
  );

  const diff = asDiff(diffFingerprints(after, before, "baseline"));

  assert.equal(diff.hashChanged, false);
  assert.deepEqual(diff.cookiesAdded, []);
  assert.deepEqual(diff.cookiesRemoved, []);
});

test("with nothing to compare against the diff is empty and comparedTo is none", () => {
  const only = fingerprint("one", [gtm], [cookie("_ga", "a.test")], "hash-a");

  const diff = asDiff(diffFingerprints(only, null, "baseline"));

  assert.equal(diff.comparedTo, "none");
  assert.deepEqual(diff.hostsAdded, []);
  assert.deepEqual(diff.cookiesAdded, []);
  assert.equal(diff.hashChanged, false);
});

// ---------------------------------------------------------------------------
// schema generations
// ---------------------------------------------------------------------------

test("a generation 1 baseline against a generation 2 sweep refuses to compare", () => {
  // generation 1 hosts carry no registrableDomain, so comparing would report
  // the site's whole tracker set as removed and re-added
  const before = fingerprint("one", [gtm], [], "hash-a", { schemaVersion: undefined });
  const after = fingerprint("two", [gtm], [], "hash-a");

  const result = diffFingerprints(after, before, "baseline");

  assert.ok(isIncompatible(result));
  assert.equal(result.comparedTo, "incompatible");
  assert.equal(result.reason, "fingerprint schema generation differs");
});

test("a generation 2 baseline against a generation 1 sweep refuses to compare", () => {
  const before = fingerprint("one", [gtm], [], "hash-a");
  const after = fingerprint("two", [gtm], [], "hash-a", { schemaVersion: undefined });

  assert.ok(isIncompatible(diffFingerprints(after, before, "baseline")));
});

test("two generation 1 fingerprints are also refused", () => {
  // both sides lack registrableDomain, so there is no sound key to compare on;
  // re-baselining onto a current-generation sweep is the only recovery
  const before = fingerprint("one", [gtm], [], "hash-a", { schemaVersion: undefined });
  const after = fingerprint("two", [gtm], [], "hash-b", { schemaVersion: undefined });

  assert.ok(isIncompatible(diffFingerprints(after, before, "previous")));
});

test("a future generation against generation 2 is refused rather than guessed at", () => {
  const before = fingerprint("one", [gtm], [], "hash-a");
  const after = fingerprint("two", [gtm], [], "hash-b", { schemaVersion: 3 });

  assert.ok(isIncompatible(diffFingerprints(after, before, "baseline")));
});

test("the schema check does not fire when there is nothing to compare against", () => {
  // a first sweep has no counterpart, so its generation is irrelevant
  const only = fingerprint("one", [gtm], [], "hash-a", { schemaVersion: undefined });

  const diff = asDiff(diffFingerprints(only, null, "baseline"));

  assert.equal(diff.comparedTo, "none");
});
