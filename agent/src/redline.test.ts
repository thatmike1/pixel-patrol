/**
 * tests for the second half of a drift run: the classification the analyst
 * records, the facts the scribe is allowed to write from, and the document it
 * produces.
 *
 * the model itself is stubbed. what is worth testing here is not whether Gemini
 * writes good Czech — nothing local can decide that — but the machinery around
 * it: that a classification survives into the stored decision, that the scribe
 * is handed the vendor tables' actual answer including "nothing", that a
 * redelivered sweep leaves one redline rather than two, and that the scribe is
 * run on drift and only on drift.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import pino from "pino";

import { runScribeIfDrift } from "./server.js";
import { cookie, fakeStore, fingerprint, host, OPTIONS } from "./test-support.js";
import { driftContext, NoDecisionError } from "./tools/get-drift-context.js";
import { hostKnowledge } from "./tools/lookup-host-knowledge.js";
import { recordDecision } from "./tools/record-decision.js";
import type { RecordDecisionArgs } from "./tools/record-decision.js";
import { writeRedline } from "./tools/write-redline.js";
import type { WriteRedlineArgs } from "./tools/write-redline.js";
import type { Decision, RopaRow } from "./types.js";

/** silent logger — these tests assert on return values, not on log output */
const log = pino({ level: "silent" });

/**
 * a site whose baseline knows one host, and a sweep that added another.
 *
 * `exampleHost` is set apart from the registrable domain where it matters,
 * because the vendor tables often name a specific subdomain and the lookup has
 * to reach it through the example the diff carries.
 */
function driftedSite(added: string, options: { exampleHost?: string; cookieName?: string } = {}) {
  const addedHost = options.exampleHost
    ? host(added, { host: options.exampleHost })
    : host(added);

  return fakeStore({ siteId: "smoke", url: "https://example.test", approvedBaselineId: "base" }, [
    fingerprint("base", 0, [host("gtm.test")]),
    fingerprint(
      "now",
      9,
      [host("gtm.test"), addedHost],
      options.cookieName ? [cookie(options.cookieName, ".example.test")] : [],
    ),
  ]);
}

/** what the analyst reports for a drift it has classified */
function driftArgs(overrides: Partial<RecordDecisionArgs> = {}): RecordDecisionArgs {
  return {
    siteId: "smoke",
    sweepId: "now",
    action: "drift",
    summary: "a new tracking domain appeared",
    hostsAdded: ["jhmt.cz"],
    noiseCount: 0,
    ...overrides,
  };
}

/** a RoPA row with every field filled, as the scribe must produce */
function ropaRow(): RopaRow {
  return {
    name: "Měření návštěvnosti webu example.test",
    purpose: "Sledování chování návštěvníků",
    legal_basis: "Souhlas (čl. 6 odst. 1 písm. a) GDPR)",
    data_categories: ["Identifikátory v cookies", "IP adresa"],
    data_subject_categories: ["Návštěvníci webu"],
    recipients: ["jhmt.cz"],
    retention_period: "Neurčeno — nutno zjistit u provozovatele",
    third_country_transfers: "Nezjištěno",
    is_dpia_required: false,
    notes: "Provozovatel domény nebyl zjištěn.",
  };
}

/** the arguments the scribe would supply */
function redlineArgs(overrides: Partial<WriteRedlineArgs> = {}): WriteRedlineArgs {
  return {
    siteId: "smoke",
    sweepId: "now",
    policyRedline: "Přidat: doména jhmt.cz, provozovatel nebyl zjištěn.",
    ropaRow: ropaRow(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

test("a classification the analyst judged is stored on the decision", async () => {
  const { store, recorded } = driftedSite("jhmt.cz");

  await recordDecision(
    store,
    "gemini-test",
    OPTIONS,
    driftArgs({
      classifications: [
        {
          domain: "jhmt.cz",
          vendor: null,
          category: "unclassified",
          confidence: "low",
          basis: "no entry in the tracker table and no heuristic match",
        },
      ],
    }),
  );

  const stored = recorded.decisions[0] as Decision;
  assert.equal(stored.classifications?.length, 1);
  assert.equal(stored.classifications?.[0]?.vendor, null);
  assert.equal(stored.classifications?.[0]?.confidence, "low");
});

test("a decision without classifications does not carry an empty field", async () => {
  // a noop is written every hour on every site; an empty array on each one is
  // storage and noise for a field that means nothing there
  const { store, recorded } = driftedSite("jhmt.cz");

  await recordDecision(store, "gemini-test", OPTIONS, driftArgs({ classifications: [] }));

  assert.equal("classifications" in (recorded.decisions[0] as Decision), false);
});

test("the lookup tool answers with the tables, not around them", () => {
  const known = hostKnowledge({
    registrableDomain: "google-analytics.com",
    exampleHost: "www.google-analytics.com",
  });
  assert.equal(known.exact?.vendor, "Google Analytics");

  const unknown = hostKnowledge({
    registrableDomain: "jhmt.cz",
    exampleHost: "cdn.jhmt.cz",
    cookieNames: ["__jhmt_c3_uid"],
  });
  assert.equal(unknown.exact, null);
  assert.deepEqual(unknown.related, []);
  assert.equal(unknown.heuristic.category, null);
  assert.equal(unknown.cookies[0]?.exact, null);
  assert.ok(unknown.categories.includes("unclassified"));
});

// ---------------------------------------------------------------------------
// what the scribe is allowed to write from
// ---------------------------------------------------------------------------

test("the drift context carries the decision, the alerts and the table answers", async () => {
  const { store } = driftedSite("hotjar.com", {
    exampleHost: "script.hotjar.com",
    cookieName: "_hjid",
  });
  await recordDecision(
    store,
    "gemini-test",
    OPTIONS,
    driftArgs({ hostsAdded: ["hotjar.com"] }),
  );

  const context = await driftContext(store, OPTIONS, { siteId: "smoke", sweepId: "now" });

  assert.equal(context.site.url, "https://example.test");
  assert.equal(context.decision.action, "drift");
  assert.deepEqual(
    context.alerts?.hostsAdded.map((entry) => entry.registrableDomain),
    ["hotjar.com"],
  );
  assert.equal(context.hosts[0]?.exact?.vendor, "Hotjar");
  // the cookie's Czech purpose text and duration are what the redline quotes
  assert.equal(context.cookies[0]?.name, "_hjid");
  assert.ok(context.cookies[0]?.exact?.description_cs);
});

test("an unidentifiable domain reaches the scribe as unidentified", async () => {
  const { store } = driftedSite("jhmt.cz");
  await recordDecision(store, "gemini-test", OPTIONS, driftArgs());

  const context = await driftContext(store, OPTIONS, { siteId: "smoke", sweepId: "now" });

  assert.equal(context.hosts.length, 1);
  assert.equal(context.hosts[0]?.exact, null);
  assert.deepEqual(context.hosts[0]?.related, []);
});

test("the scribe refuses a sweep with no decision behind it", async () => {
  const { store } = driftedSite("jhmt.cz");

  await assert.rejects(
    () => driftContext(store, OPTIONS, { siteId: "smoke", sweepId: "now" }),
    NoDecisionError,
  );
});

// ---------------------------------------------------------------------------
// the document
// ---------------------------------------------------------------------------

test("the redline is written under the sweep and carries the decision's domains", async () => {
  const { store, recorded } = driftedSite("jhmt.cz");
  await recordDecision(store, "gemini-test", OPTIONS, driftArgs());

  const result = await writeRedline(store, "gemini-test", redlineArgs());

  assert.equal(result.path, "sites/smoke/redlines/now");
  assert.equal(recorded.redlines.length, 1);
  // the domains come off the decision, not off the model's prose
  assert.deepEqual(recorded.redlines[0]?.domains, ["jhmt.cz"]);
  assert.equal(recorded.redlines[0]?.ropaRow.legal_basis, ropaRow().legal_basis);
});

test("a redelivered sweep rewrites its redline instead of adding a second", async () => {
  const { store, recorded } = driftedSite("jhmt.cz");
  await recordDecision(store, "gemini-test", OPTIONS, driftArgs());

  await writeRedline(store, "gemini-test", redlineArgs());
  await writeRedline(
    store,
    "gemini-test",
    redlineArgs({ policyRedline: "Přidat: druhá verze textu." }),
  );

  assert.equal(recorded.redlines.length, 1, "one sweep, one redline");
  assert.equal(recorded.redlines[0]?.policyRedline, "Přidat: druhá verze textu.");
});

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

test("the scribe runs on drift and writes its document", async () => {
  const { store, recorded } = driftedSite("jhmt.cz");
  await recordDecision(store, "gemini-test", OPTIONS, driftArgs());
  const decision = recorded.decisions[0] as Decision;

  const scribe = async (input: { siteId: string; sweepId: string }) => {
    await writeRedline(store, "gemini-test", redlineArgs(input));
    return { finalText: "Hotovo.", toolCalls: ["get_drift_context", "write_redline"] };
  };

  const outcome = await runScribeIfDrift({ scribe, log, store }, decision);

  assert.equal(outcome.written, true);
  assert.equal(recorded.redlines.length, 1);
});

test("the scribe does not run on a noop or a baseline", async () => {
  const { store } = driftedSite("jhmt.cz");
  let calls = 0;
  const scribe = async () => {
    calls += 1;
    return { finalText: "", toolCalls: [] };
  };

  for (const action of ["noop", "baseline-created", "failed"] as const) {
    const outcome = await runScribeIfDrift({ scribe, log, store }, {
      siteId: "smoke",
      sweepId: "now",
      action,
      summary: "",
      at: new Date().toISOString(),
      model: "gemini-test",
    });
    assert.equal(outcome.written, false);
  }
  assert.equal(calls, 0, "the hourly noop path must not pay for a second model call");
});

test("a scribe that fails leaves the drift decision standing", async () => {
  // the decision is the record the alerting is built on; sending the whole
  // delivery back through Pub/Sub would re-run the expensive analyst too
  const { store, recorded } = driftedSite("jhmt.cz");
  await recordDecision(store, "gemini-test", OPTIONS, driftArgs());
  const decision = recorded.decisions[0] as Decision;

  const outcome = await runScribeIfDrift(
    {
      scribe: async () => {
        throw new Error("vertex unavailable");
      },
      log,
      store,
    },
    decision,
  );

  assert.equal(outcome.written, false);
  assert.equal(outcome.error, "vertex unavailable");
  assert.equal(recorded.decisions.length, 1);
});

test("a scribe that finishes without writing is reported as not written", async () => {
  const { store, recorded } = driftedSite("jhmt.cz");
  await recordDecision(store, "gemini-test", OPTIONS, driftArgs());
  const decision = recorded.decisions[0] as Decision;

  const outcome = await runScribeIfDrift(
    {
      scribe: async () => ({ finalText: "I had a lovely think about it.", toolCalls: [] }),
      log,
      store,
    },
    decision,
  );

  assert.equal(outcome.written, false);
  assert.equal(recorded.redlines.length, 0);
});
