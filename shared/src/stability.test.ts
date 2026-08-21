/**
 * tests for the stability window.
 *
 * two failures matter here and they pull in opposite directions. classify a real
 * tracker as rotation and the product misses the one event it exists to catch.
 * classify rotation as a tracker and the owner mutes the alerts inside a week,
 * which misses every event after that. every branch below is one or the other.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cookieKey, diffFingerprints, isIncompatible } from "./diff.js";
import type { Fingerprint, FingerprintCookie, FingerprintHost } from "./fingerprint.js";
import {
  alertKeys,
  analyseStability,
  hasAlerts,
  isIncompatibleResult,
  isRandomizedCookieName,
  prepareWindow,
  stabilityTable,
} from "./stability.js";
import type { StabilityClass, StableDiff } from "./stability.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

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

/** a host whose registrable domain is the hostname, the common case in fixtures */
function plain(domain: string): FingerprintHost {
  return host(domain, domain);
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

/** minutes-apart sweep timestamps, so `scannedAt` ordering is unambiguous */
function at(index: number): string {
  return new Date(Date.UTC(2026, 7, 21, 12, index)).toISOString();
}

/** a generation 2 fingerprint built from just the fields the analysis reads */
function fingerprint(
  sweepId: string,
  hosts: FingerprintHost[],
  cookies: FingerprintCookie[],
  overrides: Partial<Fingerprint> = {},
): Fingerprint {
  return {
    schemaVersion: 2,
    siteId: "smoke",
    sweepId,
    siteUrl: "https://example.test",
    scannedAt: at(0),
    pagesScanned: 5,
    hosts,
    cookies,
    preConsentNonNecessaryCount: 0,
    complianceScore: 100,
    hash: `hash-${sweepId}`,
    ...overrides,
  };
}

/** asserts a result is a real verdict and narrows it */
function asDiff(result: ReturnType<typeof analyseStability>): StableDiff {
  assert.ok(!isIncompatibleResult(result), `expected a verdict, got ${JSON.stringify(result)}`);
  return result;
}

/** the classification of one registrable domain in a verdict */
function domainClass(diff: StableDiff, domain: string): StabilityClass | undefined {
  const all = [
    ...diff.alerts.hostsAdded,
    ...diff.alerts.hostsRemoved,
    ...diff.noise.flapping.flatMap((e) => (e.kind === "host" ? [e] : [])),
    ...diff.noise.missingOnce.flatMap((e) => (e.kind === "host" ? [e] : [])),
    ...diff.noise.pending.flatMap((e) => (e.kind === "host" ? [e] : [])),
  ];
  return all.find((entry) => entry.registrableDomain === domain)?.classification;
}

/** the registrable domains that alerted as additions */
function added(diff: StableDiff): string[] {
  return diff.alerts.hostsAdded.map((entry) => entry.registrableDomain);
}

/** the registrable domains that alerted as removals */
function removed(diff: StableDiff): string[] {
  return diff.alerts.hostsRemoved.map((entry) => entry.registrableDomain);
}

// ---------------------------------------------------------------------------
// one branch at a time
// ---------------------------------------------------------------------------

test("a domain in both the baseline and the sweep is stable and is reported nowhere", () => {
  const baseline = fingerprint("base", [plain("gtm.test")], []);
  const current = fingerprint("now", [plain("gtm.test")], [], { scannedAt: at(9) });

  const diff = asDiff(analyseStability(current, baseline, [], "baseline"));

  assert.equal(hasAlerts(diff), false);
  assert.equal(diff.noiseCount, 0);
  assert.equal(domainClass(diff, "gtm.test"), undefined);
});

test("a domain never seen in the window alerts as new on first sight", () => {
  // the demo case: a marketing pixel someone dropped in without asking
  const baseline = fingerprint("base", [plain("gtm.test")], []);
  const window = [1, 2, 3].map((i) =>
    fingerprint(`w${i}`, [plain("gtm.test")], [], { scannedAt: at(i) }),
  );
  const current = fingerprint(
    "now",
    [plain("gtm.test"), host("connect.facebook.net", "facebook.net", { vendor: "Meta Pixel" })],
    [],
    { scannedAt: at(9) },
  );

  const diff = asDiff(analyseStability(current, baseline, window, "baseline"));

  assert.deepEqual(added(diff), ["facebook.net"]);
  assert.equal(diff.alerts.hostsAdded[0]?.classification, "new");
  assert.equal(diff.alerts.hostsAdded[0]?.presenceRatio, 0);
  assert.equal(diff.alerts.hostsAdded[0]?.vendor, "Meta Pixel");
  assert.equal(diff.windowSize, 3);
});

test("a domain in every window sweep but not the baseline alerts as returning", () => {
  // it did not sneak in this hour, it has been there for hours and nobody
  // approved it — a persistent addition, not rotation
  const baseline = fingerprint("base", [plain("gtm.test")], []);
  const window = [1, 2, 3].map((i) =>
    fingerprint(`w${i}`, [plain("gtm.test"), plain("hotjar.test")], [], { scannedAt: at(i) }),
  );
  const current = fingerprint("now", [plain("gtm.test"), plain("hotjar.test")], [], {
    scannedAt: at(9),
  });

  const diff = asDiff(analyseStability(current, baseline, window, "baseline"));

  assert.deepEqual(added(diff), ["hotjar.test"]);
  assert.equal(diff.alerts.hostsAdded[0]?.classification, "returning");
  assert.equal(diff.alerts.hostsAdded[0]?.presenceRatio, 1);
});

test("a domain present in some window sweeps is flapping and never alerts", () => {
  const baseline = fingerprint("base", [plain("gtm.test")], []);
  const window = [
    fingerprint("w3", [plain("gtm.test"), plain("adx.test")], [], { scannedAt: at(3) }),
    fingerprint("w2", [plain("gtm.test")], [], { scannedAt: at(2) }),
    fingerprint("w1", [plain("gtm.test"), plain("adx.test")], [], { scannedAt: at(1) }),
  ];
  const current = fingerprint("now", [plain("gtm.test"), plain("adx.test")], [], {
    scannedAt: at(9),
  });

  const diff = asDiff(analyseStability(current, baseline, window, "baseline"));

  assert.equal(hasAlerts(diff), false);
  assert.equal(domainClass(diff, "adx.test"), "flapping");
  assert.equal(diff.noise.flapping[0]?.presenceRatio, 2 / 3);
  assert.equal(diff.noiseCount, 1);
});

test("a domain seen only inside the window, in neither side, is flapping", () => {
  const baseline = fingerprint("base", [plain("gtm.test")], []);
  const window = [fingerprint("w1", [plain("gtm.test"), plain("adx.test")], [], { scannedAt: at(1) })];
  const current = fingerprint("now", [plain("gtm.test")], [], { scannedAt: at(9) });

  const diff = asDiff(analyseStability(current, baseline, window, "baseline"));

  assert.equal(hasAlerts(diff), false);
  assert.equal(domainClass(diff, "adx.test"), "flapping");
});

test("a baseline domain absent from the last M sweeps alerts as gone", () => {
  const baseline = fingerprint("base", [plain("gtm.test"), plain("olddesk.test")], []);
  const window = [3, 2, 1].map((i) =>
    fingerprint(`w${i}`, [plain("gtm.test")], [], { scannedAt: at(i) }),
  );
  const current = fingerprint("now", [plain("gtm.test")], [], { scannedAt: at(9) });

  const diff = asDiff(analyseStability(current, baseline, window, "baseline", { goneAfter: 3 }));

  assert.deepEqual(removed(diff), ["olddesk.test"]);
  assert.equal(diff.alerts.hostsRemoved[0]?.classification, "gone");
});

test("a baseline domain missing from this sweep only is missing-once, not a removal", () => {
  const baseline = fingerprint("base", [plain("gtm.test"), plain("chat.test")], []);
  const window = [3, 2, 1].map((i) =>
    fingerprint(`w${i}`, [plain("gtm.test"), plain("chat.test")], [], { scannedAt: at(i) }),
  );
  const current = fingerprint("now", [plain("gtm.test")], [], { scannedAt: at(9) });

  const diff = asDiff(analyseStability(current, baseline, window, "baseline", { goneAfter: 3 }));

  assert.equal(hasAlerts(diff), false);
  assert.equal(domainClass(diff, "chat.test"), "missing-once");
  assert.equal(diff.noise.missingOnce.length, 1);
});

test("gone needs M consecutive absences, so M-1 is still missing-once", () => {
  const baseline = fingerprint("base", [plain("gtm.test"), plain("chat.test")], []);
  const window = [
    fingerprint("w3", [plain("gtm.test")], [], { scannedAt: at(3) }),
    fingerprint("w2", [plain("gtm.test")], [], { scannedAt: at(2) }),
    fingerprint("w1", [plain("gtm.test"), plain("chat.test")], [], { scannedAt: at(1) }),
  ];
  const current = fingerprint("now", [plain("gtm.test")], [], { scannedAt: at(9) });

  const three = asDiff(analyseStability(current, baseline, window, "baseline", { goneAfter: 3 }));
  const two = asDiff(analyseStability(current, baseline, window, "baseline", { goneAfter: 2 }));

  assert.equal(domainClass(three, "chat.test"), "missing-once");
  assert.deepEqual(removed(two), ["chat.test"]);
});

test("a domain already in pending is reported as pending rather than alerted again", () => {
  const baseline = fingerprint("base", [plain("gtm.test")], []);
  const window = [1, 2].map((i) => fingerprint(`w${i}`, [plain("gtm.test")], [], { scannedAt: at(i) }));
  const current = fingerprint("now", [plain("gtm.test"), plain("facebook.net")], [], {
    scannedAt: at(9),
  });

  const first = asDiff(analyseStability(current, baseline, window, "baseline"));
  const second = asDiff(
    analyseStability(current, baseline, window, "baseline", {
      pendingDomains: alertKeys(first).domains,
    }),
  );

  assert.deepEqual(added(first), ["facebook.net"]);
  assert.equal(hasAlerts(second), false);
  assert.equal(domainClass(second, "facebook.net"), "pending");
  assert.equal(second.noise.pending.length, 1);
});

test("pending suppresses a removal too, so a gone domain is reported once", () => {
  const baseline = fingerprint("base", [plain("gtm.test"), plain("olddesk.test")], []);
  const window = [3, 2, 1].map((i) =>
    fingerprint(`w${i}`, [plain("gtm.test")], [], { scannedAt: at(i) }),
  );
  const current = fingerprint("now", [plain("gtm.test")], [], { scannedAt: at(9) });

  const diff = asDiff(
    analyseStability(current, baseline, window, "baseline", {
      pendingDomains: ["olddesk.test"],
    }),
  );

  assert.equal(hasAlerts(diff), false);
  assert.equal(domainClass(diff, "olddesk.test"), "pending");
});

test("with an empty window an addition is new and a disappearance is gone", () => {
  // no history to appeal to: the first comparison after a fresh baseline says
  // what it sees, which is what the demo needs
  const baseline = fingerprint("base", [plain("gtm.test"), plain("olddesk.test")], []);
  const current = fingerprint("now", [plain("gtm.test"), plain("facebook.net")], [], {
    scannedAt: at(9),
  });

  const diff = asDiff(analyseStability(current, baseline, [], "baseline"));

  assert.deepEqual(added(diff), ["facebook.net"]);
  assert.deepEqual(removed(diff), ["olddesk.test"]);
  assert.equal(diff.windowSize, 0);
});

// ---------------------------------------------------------------------------
// cookies
// ---------------------------------------------------------------------------

test("a cookie never seen before alerts as new, keyed by name and domain", () => {
  const baseline = fingerprint("base", [], [cookie("_ga", ".example.test")]);
  const window = [1, 2].map((i) =>
    fingerprint(`w${i}`, [], [cookie("_ga", ".example.test")], { scannedAt: at(i) }),
  );
  const current = fingerprint(
    "now",
    [],
    [cookie("_ga", ".example.test"), cookie("_fbp", ".example.test", { category: "marketing" })],
    { scannedAt: at(9) },
  );

  const diff = asDiff(analyseStability(current, baseline, window, "baseline"));

  assert.deepEqual(diff.alerts.cookiesAdded, [
    {
      name: "_fbp",
      domain: ".example.test",
      category: "marketing",
      presenceRatio: 0,
      inBaseline: false,
      inCurrent: true,
      classification: "new",
    },
  ]);
});

test("a hex-suffixed cookie name is flapping by construction, never an alert", () => {
  // the name carries an identifier, so it can never match a later sweep and
  // would alert forever
  const baseline = fingerprint("base", [], []);
  const current = fingerprint("now", [], [cookie("sess_9f3ab21c", ".example.test")], {
    scannedAt: at(9),
  });

  const diff = asDiff(analyseStability(current, baseline, [], "baseline"));

  assert.equal(hasAlerts(diff), false);
  assert.equal(diff.noise.flapping[0]?.classification, "flapping");
});

test("a numeric-suffix cookie family is flapping once its siblings are in the window", () => {
  const baseline = fingerprint("base", [], []);
  const window = [
    fingerprint("w2", [], [cookie("sp_track_18", ".example.test")], { scannedAt: at(2) }),
    fingerprint("w1", [], [cookie("sp_track_42", ".example.test")], { scannedAt: at(1) }),
  ];
  const current = fingerprint("now", [], [cookie("sp_track_77", ".example.test")], {
    scannedAt: at(9),
  });

  const diff = asDiff(analyseStability(current, baseline, window, "baseline"));

  assert.equal(hasAlerts(diff), false);
  assert.equal(diff.noise.flapping.every((entry) => entry.kind === "cookie"), true);
});

test("a real analytics cookie name is not mistaken for a randomized one", () => {
  assert.equal(isRandomizedCookieName("_ga_G7X8L2K9QP"), false);
  assert.equal(isRandomizedCookieName("_fbp"), false);
  assert.equal(isRandomizedCookieName("datadome"), false);
  assert.equal(isRandomizedCookieName("sess_9f3ab21c"), true);
  assert.equal(isRandomizedCookieName("id-3f2504e0-4f89-11d3-9a0c-0305e82c3301"), true);
});

// ---------------------------------------------------------------------------
// window hygiene
// ---------------------------------------------------------------------------

test("the window drops the current sweep and any other schema generation", () => {
  const current = fingerprint("now", [], [], { scannedAt: at(9) });
  const window = [
    fingerprint("now", [], [], { scannedAt: at(9) }),
    fingerprint("old", [], [], { scannedAt: at(1), schemaVersion: 1 }),
    fingerprint("w2", [], [], { scannedAt: at(2) }),
  ];

  const prepared = prepareWindow(current, window);

  assert.deepEqual(
    prepared.map((fp) => fp.sweepId),
    ["w2"],
  );
});

test("the window is ordered newest first regardless of how it arrives", () => {
  const current = fingerprint("now", [], [], { scannedAt: at(9) });
  const window = [1, 3, 2].map((i) => fingerprint(`w${i}`, [], [], { scannedAt: at(i) }));

  assert.deepEqual(
    prepareWindow(current, window).map((fp) => fp.sweepId),
    ["w3", "w2", "w1"],
  );
});

test("a cross-generation comparison is refused rather than guessed at", () => {
  const baseline = fingerprint("base", [plain("gtm.test")], [], { schemaVersion: undefined });
  const current = fingerprint("now", [plain("gtm.test")], [], { scannedAt: at(9) });

  const result = analyseStability(current, baseline, [], "baseline");

  assert.ok(isIncompatibleResult(result));
  assert.equal(result.reason, "fingerprint schema generation differs");
});

test("with nothing to compare against the verdict is empty and comparedTo is none", () => {
  const current = fingerprint("now", [plain("gtm.test")], [], { scannedAt: at(9) });

  const diff = asDiff(analyseStability(current, null, [], "baseline"));

  assert.equal(diff.comparedTo, "none");
  assert.equal(hasAlerts(diff), false);
  assert.equal(diff.noiseCount, 0);
});

test("the table keeps stable entries the split verdict leaves out", () => {
  const baseline = fingerprint("base", [plain("gtm.test")], []);
  const current = fingerprint("now", [plain("gtm.test"), plain("facebook.net")], [], {
    scannedAt: at(9),
  });

  const table = stabilityTable(current, baseline, [], "baseline");

  assert.deepEqual(
    table.hosts.map((entry) => [entry.registrableDomain, entry.classification]),
    [
      ["facebook.net", "new"],
      ["gtm.test", "stable"],
    ],
  );
});

// ---------------------------------------------------------------------------
// the whole thing, on a site that behaves like a real one
// ---------------------------------------------------------------------------

test("six sweeps of a rotating ad site alert on the pixel and nothing else", () => {
  // sdn.cz shards rotate hostnames every sweep (already collapsed by eTLD+1),
  // alza.cz and heureka.cz flap in and out as programmatic slots fill, and
  // facebook.net shows up only in the last sweep. exactly one of those is drift.
  const constant = [plain("gtm.test"), plain("seznam.cz")];
  const shard = (n: number): FingerprintHost => host(`d${n}-a.sdn.cz`, "sdn.cz");

  const sweeps: Fingerprint[] = [
    fingerprint("s1", [...constant, shard(15), plain("alza.cz")], [], { scannedAt: at(1) }),
    fingerprint("s2", [...constant, shard(21), plain("heureka.cz")], [], { scannedAt: at(2) }),
    fingerprint("s3", [...constant, shard(4), plain("alza.cz"), plain("heureka.cz")], [], {
      scannedAt: at(3),
    }),
    fingerprint("s4", [...constant, shard(38)], [], { scannedAt: at(4) }),
    fingerprint("s5", [...constant, shard(2), plain("alza.cz")], [], { scannedAt: at(5) }),
  ];
  const baseline = fingerprint("base", [...constant, shard(9)], [], { scannedAt: at(0) });
  const current = fingerprint(
    "s6",
    [
      ...constant,
      shard(44),
      plain("heureka.cz"),
      host("connect.facebook.net", "facebook.net", { vendor: "Meta Pixel", category: "marketing" }),
    ],
    [],
    { scannedAt: at(6) },
  );

  const diff = asDiff(analyseStability(current, baseline, sweeps, "baseline", { goneAfter: 3 }));

  assert.equal(diff.windowSize, 5);
  assert.deepEqual(added(diff), ["facebook.net"]);
  assert.deepEqual(removed(diff), []);
  assert.deepEqual(diff.alerts.cookiesAdded, []);
  assert.deepEqual(diff.alerts.cookiesRemoved, []);
  // the rotation is reported, so the summary can say how much was ignored
  assert.deepEqual(
    diff.noise.flapping.map((entry) => (entry.kind === "host" ? entry.registrableDomain : entry.name)),
    ["alza.cz", "heureka.cz"],
  );
  assert.equal(diff.noiseCount, 2);
  // sdn.cz never moves, because the shards collapse to one registrable domain
  assert.equal(domainClass(diff, "sdn.cz"), undefined);
  assert.deepEqual(alertKeys(diff), { domains: ["facebook.net"], cookies: [] });
});

test("the same six sweeps go quiet once the pixel is pending", () => {
  const constant = [plain("gtm.test"), plain("seznam.cz")];
  const sweeps = [1, 2, 3, 4, 5].map((i) => fingerprint(`s${i}`, constant, [], { scannedAt: at(i) }));
  const baseline = fingerprint("base", constant, [], { scannedAt: at(0) });
  const current = fingerprint("s6", [...constant, plain("facebook.net")], [], { scannedAt: at(6) });

  const first = asDiff(analyseStability(current, baseline, sweeps, "baseline"));
  const pending = alertKeys(first);
  const second = asDiff(
    analyseStability(current, baseline, sweeps, "baseline", {
      pendingDomains: pending.domains,
      pendingCookies: pending.cookies,
    }),
  );

  assert.deepEqual(added(first), ["facebook.net"]);
  assert.equal(hasAlerts(second), false);
  assert.equal(second.noise.pending.length, 1);
});

test("alertKeys names cookies by the same key the pending set uses", () => {
  const baseline = fingerprint("base", [], []);
  const current = fingerprint("now", [], [cookie("_fbp", ".example.test")], { scannedAt: at(9) });

  const diff = asDiff(analyseStability(current, baseline, [], "baseline"));

  assert.deepEqual(alertKeys(diff).cookies, [cookieKey({ name: "_fbp", domain: ".example.test" })]);
});

test("every alert is also a plain set difference, and never the other way round", () => {
  // the stability layer may only ever REMOVE entries from the raw diff. if it
  // could add one, the product would be alerting on something that is not
  // actually a difference between the two fingerprints.
  const constant = [plain("gtm.test"), plain("seznam.cz")];
  const baseline = fingerprint("base", [...constant, plain("olddesk.test")], [
    cookie("_ga", ".ex.test"),
  ]);
  const window = [
    fingerprint("w2", [...constant, plain("alza.cz")], [], { scannedAt: at(2) }),
    fingerprint("w1", [...constant], [], { scannedAt: at(1) }),
  ];
  const current = fingerprint(
    "now",
    [...constant, plain("alza.cz"), plain("facebook.net")],
    [cookie("_fbp", ".ex.test")],
    { scannedAt: at(9) },
  );

  const raw = diffFingerprints(current, baseline, "baseline");
  assert.ok(!isIncompatible(raw));
  const stable = asDiff(analyseStability(current, baseline, window, "baseline"));

  const rawAdded = new Set(raw.hostsAdded.map((e) => e.registrableDomain));
  const rawRemoved = new Set(raw.hostsRemoved.map((e) => e.registrableDomain));
  for (const entry of stable.alerts.hostsAdded) {
    assert.ok(rawAdded.has(entry.registrableDomain), `${entry.registrableDomain} is not an addition`);
  }
  for (const entry of stable.alerts.hostsRemoved) {
    assert.ok(rawRemoved.has(entry.registrableDomain), `${entry.registrableDomain} is not a removal`);
  }
  // and the layer really is doing work: the raw diff has more than the alerts do
  assert.equal(rawAdded.size, 2);
  assert.deepEqual(added(stable), ["facebook.net"]);
  assert.deepEqual(
    stable.alerts.cookiesAdded.map((e) => e.name),
    ["_fbp"],
  );
});
