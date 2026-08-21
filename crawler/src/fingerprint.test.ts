import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFingerprint } from "./fingerprint.js";
import type {
  ClassifiedCookie,
  ClassifiedTracker,
  ScanResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/**
 * a cookie carrying a value, as a crawler that leaked one would produce.
 * ClassifiedCookie has no `value` field, so this is the only way to prove the
 * fingerprint drops unknown fields rather than spreading them through.
 */
type LeakyCookie = ClassifiedCookie & { value: string };

const SITE_URL = "https://example.com";

function cookie(
  name: string,
  domain: string,
  overrides: Partial<LeakyCookie> = {},
): LeakyCookie {
  return {
    name,
    domain,
    path: "/",
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
    durationSeconds: 3600,
    foundOnUrl: SITE_URL,
    initiatorScript: null,
    isFirstParty: domain === "example.com",
    category: "analytics",
    categorySource: "auto",
    description: null,
    value: "super-secret-session-token",
    ...overrides,
  };
}

function tracker(domain: string): ClassifiedTracker {
  return {
    url: `https://${domain}/tag.js`,
    domain,
    type: "script",
    foundOnUrl: SITE_URL,
    vendorName: "Some Vendor",
    category: "analytics",
  };
}

function scanResult(
  cookies: ClassifiedCookie[],
  trackers: ClassifiedTracker[],
): ScanResult {
  return {
    siteId: "site-1",
    scanJobId: "sweep-1",
    pagesScanned: 3,
    pages: [],
    cookies,
    trackers,
    complianceScore: 72,
    summary: {
      memoryWarning: false,
      preConsentNonNecessaryCount: 2,
      unclassifiedCount: 0,
      categoryBreakdown: {
        necessary: 0,
        analytics: cookies.length,
        marketing: 0,
        functional: 0,
        unclassified: 0,
      },
    },
  };
}

const META = {
  siteId: "site-1",
  sweepId: "sweep-1",
  siteUrl: SITE_URL,
  scannedAt: "2026-08-21T18:00:00.000Z",
};

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test("hash ignores input order and cookie duration churn", () => {
  const first = buildFingerprint(
    scanResult(
      [cookie("_ga", "example.com"), cookie("_fbp", "example.com")],
      [tracker("google-analytics.com"), tracker("connect.facebook.net")],
    ),
    META,
  );

  // same hosts and cookies, reversed, with every duration changed
  const second = buildFingerprint(
    scanResult(
      [
        cookie("_fbp", "example.com", { durationSeconds: 999 }),
        cookie("_ga", "example.com", { durationSeconds: null }),
      ],
      [tracker("connect.facebook.net"), tracker("google-analytics.com")],
    ),
    { ...META, sweepId: "sweep-2", scannedAt: "2026-08-22T18:00:00.000Z" },
  );

  assert.equal(second.hash, first.hash);

  // the sorted arrays themselves are order-independent too
  assert.deepEqual(
    second.hosts.map((h) => h.host),
    first.hosts.map((h) => h.host),
  );
  assert.deepEqual(
    second.cookies.map((c) => c.name),
    first.cookies.map((c) => c.name),
  );
});

test("hash changes when a host is added", () => {
  const before = buildFingerprint(
    scanResult([cookie("_ga", "example.com")], [tracker("google-analytics.com")]),
    META,
  );

  const after = buildFingerprint(
    scanResult(
      [cookie("_ga", "example.com")],
      [tracker("google-analytics.com"), tracker("hotjar.com")],
    ),
    META,
  );

  assert.notEqual(after.hash, before.hash);
  assert.equal(after.hosts.length, before.hosts.length + 1);
});

test("hash changes when a cookie is added", () => {
  const before = buildFingerprint(
    scanResult([cookie("_ga", "example.com")], [tracker("google-analytics.com")]),
    META,
  );

  const after = buildFingerprint(
    scanResult(
      [cookie("_ga", "example.com"), cookie("_fbp", "example.com")],
      [tracker("google-analytics.com")],
    ),
    META,
  );

  assert.notEqual(after.hash, before.hash);
});

test("cookie values never reach the fingerprint", () => {
  const secret = "super-secret-session-token";
  const fp = buildFingerprint(
    scanResult(
      [
        cookie("PHPSESSID", "example.com", { value: secret }),
        cookie("_ga", "example.com", { value: secret }),
      ],
      [tracker("google-analytics.com")],
    ),
    META,
  );

  assert.ok(!JSON.stringify(fp).includes(secret));

  for (const c of fp.cookies) {
    assert.deepEqual(Object.keys(c).sort(), [
      "category",
      "domain",
      "durationSeconds",
      "isFirstParty",
      "name",
      "path",
    ]);
  }
});

test("hosts are deduped by host name", () => {
  const fp = buildFingerprint(
    scanResult(
      [],
      [
        tracker("google-analytics.com"),
        tracker("google-analytics.com"),
        tracker("hotjar.com"),
      ],
    ),
    META,
  );

  assert.deepEqual(
    fp.hosts.map((h) => h.host),
    ["google-analytics.com", "hotjar.com"],
  );
});
