/**
 * tests for the store-backed half of the drift analysis.
 *
 * the pure classification is tested in `@pixel-patrol/shared`. what is tested
 * here is everything between Firestore and that classifier, which is where the
 * alerting behaviour actually gets decided in production: which snapshot a sweep
 * is measured against, how much history it is given, whether a finding that was
 * already reported stays quiet, and whether recording drift parks the right keys
 * so the next hourly sweep does not repeat it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { analyseDrift, verdictOf } from "./drift.js";
import type { DriftOptions } from "./drift.js";
import { pendingFields } from "./firestore.js";
import type { Store } from "./firestore.js";
import { loadComparison, NotFoundError, toSweepContext } from "./sweep-context.js";
import { cookie, fakeStore, fingerprint, host, OPTIONS } from "./test-support.js";
import { approveBaseline } from "./tools/approve-baseline.js";
import { recordDecision } from "./tools/record-decision.js";
import type { RecordDecisionArgs } from "./tools/record-decision.js";

/** the verdict for a sweep, asserted to exist */
async function analyse(store: Store, sweepId: string, options: DriftOptions = OPTIONS) {
  const analysis = await analyseDrift(store, "smoke", sweepId, options);
  const verdict = verdictOf(analysis);
  assert.ok(verdict, "expected a verdict, got a refusal");
  return { analysis, verdict };
}

/** a decision the model would report for a drift verdict */
function driftArgs(sweepId: string, hostsAdded: string[]): RecordDecisionArgs {
  return {
    siteId: "smoke",
    sweepId,
    action: "drift",
    summary: `new tracking domains: ${hostsAdded.join(", ")}`,
    hostsAdded,
    noiseCount: 0,
  };
}

// ---------------------------------------------------------------------------
// which snapshot, and how much history
// ---------------------------------------------------------------------------

test("the approved baseline is the reference, not the previous sweep", async () => {
  // measuring against yesterday's already-drifted state is how a tracker gets
  // silently blessed one sweep at a time
  const { store } = fakeStore(
    { siteId: "smoke", url: "https://example.test", approvedBaselineId: "base" },
    [
      fingerprint("base", 0, [host("gtm.test")]),
      fingerprint("s1", 1, [host("gtm.test"), host("facebook.net")]),
      fingerprint("s2", 2, [host("gtm.test"), host("facebook.net")]),
    ],
  );

  const { analysis, verdict } = await analyse(store, "s2");

  assert.equal(analysis.comparison.comparedTo, "baseline");
  assert.equal(verdict.comparedTo, "baseline");
  assert.deepEqual(
    verdict.alerts.hostsAdded.map((e) => e.registrableDomain),
    ["facebook.net"],
  );
});

test("with no approved baseline the previous sweep is the reference", async () => {
  const { store } = fakeStore({ siteId: "smoke", url: "https://example.test" }, [
    fingerprint("s1", 1, [host("gtm.test")]),
    fingerprint("s2", 2, [host("gtm.test"), host("facebook.net")]),
  ]);

  const { analysis } = await analyse(store, "s2");

  assert.equal(analysis.comparison.comparedTo, "previous");
  assert.equal(analysis.comparison.previous?.sweepId, "s1");
});

test("the window holds the N sweeps before this one, newest first", async () => {
  const { store } = fakeStore(
    { siteId: "smoke", url: "https://example.test", approvedBaselineId: "base" },
    [
      fingerprint("base", 0, [host("gtm.test")]),
      ...[1, 2, 3, 4, 5, 6].map((i) => fingerprint(`s${i}`, i, [host("gtm.test")])),
      fingerprint("now", 9, [host("gtm.test")]),
    ],
  );

  const { analysis, verdict } = await analyse(store, "now");

  assert.deepEqual(
    analysis.comparison.window.map((fp) => fp.sweepId),
    ["s6", "s5", "s4", "s3", "s2", "s1"].slice(0, 5),
  );
  assert.equal(verdict.windowSize, 5);
});

test("a later sweep is never pulled into the window of an earlier one", async () => {
  // a redelivered sweep-done for an old sweep would otherwise be measured
  // against newer history and report every delta backwards
  const { store } = fakeStore({ siteId: "smoke", url: "https://example.test" }, [
    fingerprint("s1", 1, [host("gtm.test")]),
    fingerprint("s2", 2, [host("gtm.test")]),
    fingerprint("s3", 3, [host("gtm.test"), host("facebook.net")]),
  ]);

  const { analysis } = await analyse(store, "s2");

  assert.deepEqual(
    analysis.comparison.window.map((fp) => fp.sweepId),
    ["s1"],
  );
});

test("a first sweep has nothing to compare against", async () => {
  const { store } = fakeStore({ siteId: "smoke", url: "https://example.test" }, [
    fingerprint("only", 1, [host("gtm.test")]),
  ]);

  const { analysis, verdict } = await analyse(store, "only");

  assert.equal(analysis.comparison.comparedTo, "none");
  assert.equal(verdict.comparedTo, "none");
  assert.equal(verdict.noiseCount, 0);
});

test("an unregistered site and a missing fingerprint both refuse loudly", async () => {
  const { store: noSite } = fakeStore(null, []);
  await assert.rejects(
    () => analyseDrift(noSite, "smoke", "s1", OPTIONS),
    (err: unknown) => err instanceof NotFoundError,
  );

  const { store: noFingerprint } = fakeStore({ siteId: "smoke", url: "https://example.test" }, []);
  await assert.rejects(
    () => analyseDrift(noFingerprint, "smoke", "s1", OPTIONS),
    (err: unknown) => err instanceof NotFoundError,
  );
});

// ---------------------------------------------------------------------------
// noise, on a site that behaves like a real one
// ---------------------------------------------------------------------------

test("a domain that rotates through the site's own sweeps is noise, not drift", async () => {
  const { store } = fakeStore(
    { siteId: "smoke", url: "https://example.test", approvedBaselineId: "base" },
    [
      fingerprint("base", 0, [host("gtm.test")]),
      fingerprint("s1", 1, [host("gtm.test"), host("alza.cz")]),
      fingerprint("s2", 2, [host("gtm.test")]),
      fingerprint("s3", 3, [host("gtm.test"), host("alza.cz")]),
      fingerprint("now", 9, [host("gtm.test"), host("alza.cz")]),
    ],
  );

  const { verdict } = await analyse(store, "now");

  assert.deepEqual(verdict.alerts.hostsAdded, []);
  assert.equal(verdict.noiseCount, 1);
  assert.equal(verdict.noise.flapping[0]?.classification, "flapping");
});

test("a pixel that appears for the first time alerts even beside rotation", async () => {
  const { store } = fakeStore(
    { siteId: "smoke", url: "https://example.test", approvedBaselineId: "base" },
    [
      fingerprint("base", 0, [host("gtm.test")]),
      fingerprint("s1", 1, [host("gtm.test"), host("alza.cz")]),
      fingerprint("s2", 2, [host("gtm.test")]),
      fingerprint("now", 9, [
        host("gtm.test"),
        host("alza.cz"),
        host("facebook.net", { vendor: "Meta Pixel", category: "marketing" }),
      ]),
    ],
  );

  const { verdict } = await analyse(store, "now");

  assert.deepEqual(
    verdict.alerts.hostsAdded.map((e) => e.registrableDomain),
    ["facebook.net"],
  );
  assert.equal(verdict.noiseCount, 1);
});

// ---------------------------------------------------------------------------
// pending: report a finding once, not every hour
// ---------------------------------------------------------------------------

test("recording drift parks the alerted keys as pending", async () => {
  const { store, recorded } = fakeStore(
    { siteId: "smoke", url: "https://example.test", approvedBaselineId: "base" },
    [
      fingerprint("base", 0, [host("gtm.test")]),
      fingerprint("now", 9, [host("gtm.test"), host("facebook.net")], [cookie("_fbp", ".ex.test")]),
    ],
  );

  await recordDecision(store, "gemini-test", OPTIONS, driftArgs("now", ["facebook.net"]));

  assert.deepEqual(recorded.pending, [
    { domains: ["facebook.net"], cookies: [".ex.test _fbp"], sweepId: "now" },
  ]);
});

test("the parked keys come from the classifier, not from what the model retyped", async () => {
  // the model naming the wrong string would silently break dedupe: the next
  // sweep would not recognise the finding and would alert on it again
  const { store, recorded } = fakeStore(
    { siteId: "smoke", url: "https://example.test", approvedBaselineId: "base" },
    [
      fingerprint("base", 0, [host("gtm.test")]),
      fingerprint("now", 9, [host("gtm.test"), host("facebook.net")]),
    ],
  );

  await recordDecision(store, "gemini-test", OPTIONS, {
    ...driftArgs("now", ["connect.facebook.net"]),
    noiseCount: 99,
  });

  assert.deepEqual(recorded.pending[0]?.domains, ["facebook.net"]);
  // and the count is the computed one, not the model's
  assert.equal(recorded.decisions[0]?.noiseCount, 0);
  // what the model reported is still stored, because that is the human-facing record
  assert.deepEqual(recorded.decisions[0]?.hostsAdded, ["connect.facebook.net"]);
});

test("the next sweep reports a pending finding as pending rather than alerting again", async () => {
  const { store } = fakeStore(
    { siteId: "smoke", url: "https://example.test", approvedBaselineId: "base" },
    [
      fingerprint("base", 0, [host("gtm.test")]),
      fingerprint("first", 1, [host("gtm.test"), host("facebook.net")]),
      fingerprint("second", 2, [host("gtm.test"), host("facebook.net")]),
    ],
  );

  await recordDecision(store, "gemini-test", OPTIONS, driftArgs("first", ["facebook.net"]));
  const { verdict } = await analyse(store, "second");

  assert.deepEqual(verdict.alerts.hostsAdded, []);
  assert.equal(verdict.noise.pending.length, 1);
  assert.equal(verdict.noiseCount, 1);
});

test("re-analysing the sweep that parked a finding still reports it as drift", async () => {
  // Pub/Sub redelivers; without the pendingSweepId escape the second pass would
  // suppress the sweep's own findings and overwrite its verdict with a noop
  const { store } = fakeStore(
    { siteId: "smoke", url: "https://example.test", approvedBaselineId: "base" },
    [
      fingerprint("base", 0, [host("gtm.test")]),
      fingerprint("now", 9, [host("gtm.test"), host("facebook.net")]),
    ],
  );

  await recordDecision(store, "gemini-test", OPTIONS, driftArgs("now", ["facebook.net"]));
  const { verdict } = await analyse(store, "now");

  assert.deepEqual(
    verdict.alerts.hostsAdded.map((e) => e.registrableDomain),
    ["facebook.net"],
  );
});

test("a noop records the computed noise count and parks nothing", async () => {
  const { store, recorded } = fakeStore(
    { siteId: "smoke", url: "https://example.test", approvedBaselineId: "base" },
    [
      fingerprint("base", 0, [host("gtm.test")]),
      fingerprint("s1", 1, [host("gtm.test"), host("alza.cz")]),
      fingerprint("s2", 2, [host("gtm.test")]),
      fingerprint("now", 9, [host("gtm.test"), host("alza.cz")]),
    ],
  );

  await recordDecision(store, "gemini-test", OPTIONS, {
    siteId: "smoke",
    sweepId: "now",
    action: "noop",
    summary: "unchanged since base, 1 rotating ad-tech domain ignored",
  });

  assert.equal(recorded.decisions[0]?.action, "noop");
  assert.equal(recorded.decisions[0]?.noiseCount, 1);
  assert.deepEqual(recorded.pending, []);
});

test("a baseline-created decision records without recomputing a comparison", async () => {
  const { store, recorded } = fakeStore({ siteId: "smoke", url: "https://example.test" }, [
    fingerprint("only", 1, [host("gtm.test")]),
  ]);

  await approveBaseline(store, "smoke", "only");
  await recordDecision(store, "gemini-test", OPTIONS, {
    siteId: "smoke",
    sweepId: "only",
    action: "baseline-created",
    summary: "first sweep: 1 third-party host, 0 cookies",
  });

  assert.deepEqual(recorded.approvals, ["only"]);
  assert.equal(recorded.decisions[0]?.action, "baseline-created");
  assert.equal(recorded.decisions[0]?.noiseCount, 0);
  assert.deepEqual(recorded.pending, []);
});

test("approving a baseline clears pending, so the same domain can alert again later", async () => {
  const { store } = fakeStore(
    {
      siteId: "smoke",
      url: "https://example.test",
      approvedBaselineId: "base",
      pendingDomains: ["facebook.net"],
      pendingSweepId: "old",
    },
    [
      fingerprint("base", 0, [host("gtm.test")]),
      fingerprint("cleared", 1, [host("gtm.test")]),
      fingerprint("now", 9, [host("gtm.test"), host("facebook.net")]),
    ],
  );

  const suppressed = await analyse(store, "now");
  assert.deepEqual(suppressed.verdict.alerts.hostsAdded, []);

  await approveBaseline(store, "smoke", "cleared");
  const after = await analyse(store, "now");

  assert.deepEqual(
    after.verdict.alerts.hostsAdded.map((e) => e.registrableDomain),
    ["facebook.net"],
  );
});

// ---------------------------------------------------------------------------
// what the model is told before it looks at a diff
// ---------------------------------------------------------------------------

test("the sweep context reports the window and pending sizes the diff will use", async () => {
  const { store } = fakeStore(
    {
      siteId: "smoke",
      url: "https://example.test",
      approvedBaselineId: "base",
      pendingDomains: ["facebook.net"],
      pendingCookies: [".ex.test _fbp"],
    },
    [
      fingerprint("base", 0, [host("gtm.test")]),
      fingerprint("s1", 1, [host("gtm.test")]),
      fingerprint("s2", 2, [host("gtm.test")]),
      fingerprint("now", 9, [host("gtm.test")]),
    ],
  );

  const context = toSweepContext(await loadComparison(store, "smoke", "now", 5));

  assert.equal(context.windowSize, 3);
  assert.equal(context.pendingCount, 2);
  assert.equal(context.baseline?.sweepId, "base");
  assert.equal(context.previous?.sweepId, "s2");
  assert.equal(context.fingerprint.schemaVersion, 2);
});

test("a cross-generation baseline is refused rather than compared", async () => {
  const { store } = fakeStore(
    { siteId: "smoke", url: "https://example.test", approvedBaselineId: "base" },
    [
      fingerprint("base", 0, [host("gtm.test")], [], { schemaVersion: undefined }),
      fingerprint("now", 9, [host("gtm.test")]),
    ],
  );

  const analysis = await analyseDrift(store, "smoke", "now", OPTIONS);

  assert.equal(verdictOf(analysis), null);
  assert.equal(analysis.result.comparedTo, "incompatible");
});

test("parking a domain-only finding writes no empty cookie array", () => {
  // FieldValue.arrayUnion() throws when handed nothing, and a drift with domains
  // and no cookies is the ordinary case
  assert.deepEqual(
    Object.keys(pendingFields({ domains: ["facebook.net"], cookies: [], sweepId: "now" })),
    ["pendingDomains", "pendingSweepId"],
  );
  assert.deepEqual(
    Object.keys(pendingFields({ domains: [], cookies: [".ex.test _fbp"], sweepId: "now" })),
    ["pendingCookies", "pendingSweepId"],
  );
});
