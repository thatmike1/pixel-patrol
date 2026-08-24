/**
 * plants a drift in a site's approved baseline, for a demo.
 *
 * the honest way to show this system working is to wait for a real site to add
 * a tracker, which happens on nobody's schedule. this does the equivalent from
 * the other end: it deletes a domain the site genuinely loads out of the
 * approved baseline, so the very next sweep finds that domain present and
 * unaccounted for and reports it as an addition.
 *
 * that is the same signal, produced by the same code path — the differ, the
 * stability classification, the analyst and the scribe all run on real crawl
 * data and none of them is aware anything was arranged. what is faked is the
 * approval history, which is the one part of the story a demo cannot wait for.
 *
 *   npm --prefix agent run seed-drift -- demo-shop                       # list
 *   npm --prefix agent run seed-drift -- demo-shop doubleclick.net       # plant
 *
 * with no domains it prints the baseline's, so the next call can name ones the
 * site actually loads.
 */

import { Firestore } from "@google-cloud/firestore";

import type { Fingerprint, Site } from "../src/types.js";

const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.PROJECT_ID ?? "pixel-patrol-mp";
const [siteId, ...domains] = process.argv.slice(2);

if (!siteId) {
  console.error("usage: seed-drift <siteId> [registrableDomain ...]");
  process.exit(1);
}

const db = new Firestore({ projectId });

const siteDoc = await db.doc(`sites/${siteId}`).get();
if (!siteDoc.exists) throw new Error(`no site at sites/${siteId}`);
const site = siteDoc.data() as Site;

const baselineId = site.approvedBaselineId;
if (!baselineId) throw new Error(`sites/${siteId} has no approved baseline to edit`);

const ref = db.doc(`sites/${siteId}/fingerprints/${baselineId}`);
const snapshot = await ref.get();
if (!snapshot.exists) throw new Error(`no fingerprint at ${ref.path}`);
const baseline = snapshot.data() as Fingerprint;

if (domains.length === 0) {
  console.log(`baseline ${baselineId} — ${baseline.hosts.length} hosts`);
  for (const entry of [...new Set(baseline.hosts.map((h) => h.registrableDomain))].sort()) {
    const known = baseline.hosts.find((h) => h.registrableDomain === entry);
    console.log(`  ${entry}${known?.vendor ? `  (${known.vendor})` : ""}`);
  }
  process.exit(0);
}

const wanted = new Set(domains);
const kept = baseline.hosts.filter((entry) => !wanted.has(entry.registrableDomain));
const removed = baseline.hosts.length - kept.length;
if (removed === 0) {
  throw new Error(`none of ${domains.join(", ")} is in the baseline; run without domains to list them`);
}

// the hash is left alone on purpose. it is a fingerprint of what the crawler
// saw, not of this document, and rewriting it would make the baseline claim to
// be a scan that never happened.
await ref.update({ hosts: kept });

console.log(`removed ${removed} host entr${removed === 1 ? "y" : "ies"} from ${ref.path}`);
console.log(`domains: ${domains.join(", ")}`);
console.log(`the next sweep of ${siteId} should report them as added`);
