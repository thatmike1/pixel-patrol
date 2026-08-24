/**
 * tests for the grounding the agent classifies unknown hosts against.
 *
 * the assertions are about honesty rather than coverage. what has to hold is
 * that a domain the tables name comes back named, that a domain merely related
 * to a known vendor comes back as related and NOT as an exact answer, and that
 * a domain nothing knows anything about comes back empty on every tier — that
 * last case is the one a model would otherwise be tempted to fill in, and it is
 * the case a real drift alert actually hits.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  brandToken,
  heuristicCookieCategory,
  heuristicHostCategory,
  lookupCookieKnowledge,
  lookupHostKnowledge,
  trackerCategories,
} from "./knowledge.js";

test("a domain the tracker table names comes back with its vendor", () => {
  const knowledge = lookupHostKnowledge("google-analytics.com", "www.google-analytics.com");

  assert.equal(knowledge.exact?.vendor, "Google Analytics");
  assert.equal(knowledge.exact?.category, "analytics");
  assert.equal(knowledge.registrableDomain, "google-analytics.com");
});

test("a subdomain the table names is found through the example host", () => {
  // the registrable domain alone is absent from the table here; the example
  // host is the only way in, which is why the tool takes both
  const knowledge = lookupHostKnowledge("hotjar.com", "script.hotjar.com");

  assert.equal(knowledge.exact?.vendor, "Hotjar");
});

test("an unlisted sibling of a known vendor is related, not exact", () => {
  const knowledge = lookupHostKnowledge("hotjar-cdn.io", "x.hotjar-cdn.io");

  assert.equal(knowledge.exact, null, "an unlisted domain must not be answered as a table hit");
  assert.ok(knowledge.related.length > 0, "the vendor's listed domains should surface");
  assert.ok(knowledge.related.every((entry) => entry.vendor.startsWith("Hotjar")));
  assert.ok(knowledge.relatedCookies.some((entry) => entry.name.startsWith("_hj")));
});

test("a domain nothing knows about comes back empty on every tier", () => {
  const knowledge = lookupHostKnowledge("jhmt.cz", "cdn.jhmt.cz");

  assert.equal(knowledge.exact, null);
  assert.deepEqual(knowledge.related, []);
  assert.deepEqual(knowledge.relatedCookies, []);
  assert.equal(knowledge.heuristic.category, null);
  assert.equal(knowledge.heuristic.matchedRule, null);
});

test("the taxonomy is a closed set that always offers unclassified", () => {
  const categories = trackerCategories();

  assert.ok(categories.includes("unclassified"));
  assert.ok(categories.includes("analytics"));
  assert.ok(categories.includes("marketing"));
  // a tracker is never necessary by definition; offering it would let a
  // consent-free tracker be blessed by picking the wrong word
  assert.ok(!categories.includes("necessary" as never));
  assert.deepEqual([...categories].sort(), categories);
});

test("host heuristics report the rule that fired, or nothing at all", () => {
  const ads = heuristicHostCategory("pixel.example-ads.net");
  assert.equal(ads.category, "analytics");
  assert.ok(ads.matchedRule);

  const nothing = heuristicHostCategory("jhmt.cz");
  assert.equal(nothing.category, null);
  assert.equal(nothing.matchedRule, null);
});

test("cookie knowledge falls through table, heuristic, then nothing", () => {
  const known = lookupCookieKnowledge("_ga");
  assert.equal(known.exact?.vendor, "Google Analytics");

  const heuristicOnly = lookupCookieKnowledge("_hjSomethingNew");
  assert.equal(heuristicOnly.exact, null);
  assert.equal(heuristicOnly.heuristic, "analytics");

  const unknown = lookupCookieKnowledge("__jhmt_c3_uid");
  assert.equal(unknown.exact, null);
  assert.equal(unknown.heuristic, null);
});

test("brand tokens too short to be evidence are refused", () => {
  assert.equal(brandToken("jhmt.cz"), "jhmt");
  assert.equal(brandToken("ad.io"), null);
  assert.equal(heuristicCookieCategory("PHPSESSID"), "necessary");
});
