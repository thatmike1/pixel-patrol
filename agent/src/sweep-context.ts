/**
 * what a sweep is measured against, and the shape the model sees.
 *
 * both `get_sweep_context` and `diff_against_baseline` need the same question
 * answered — which earlier snapshot is this sweep's reference point — and they
 * must answer it identically, or the model reads a context that says "no
 * baseline" and then a diff computed against one. so it is resolved here once.
 */

import type { DiffBasis } from "./diff.js";
import type { Store } from "./firestore.js";
import type { Fingerprint, Site } from "./types.js";

/** the digest of a fingerprint handed to the model — counts, not full lists */
export interface FingerprintSummary {
  sweepId: string;
  /** schema generation; 1 for documents written before the crawler stamped it */
  schemaVersion: number;
  hash: string;
  hostsCount: number;
  cookiesCount: number;
  preConsentNonNecessaryCount: number;
  complianceScore: number;
  scannedAt: string;
}

/** everything the analyst needs to know before it looks at a diff */
export interface SweepContext {
  site: { siteId: string; url: string; ownerEmail?: string; approvedBaselineId?: string };
  fingerprint: FingerprintSummary;
  baseline: FingerprintSummary | null;
  previous: FingerprintSummary | null;
}

/** the resolved comparison for one sweep, before it is summarized or diffed */
export interface Comparison {
  site: Site;
  current: Fingerprint;
  baseline: Fingerprint | null;
  previous: Fingerprint | null;
  /** the snapshot drift is actually measured against */
  against: Fingerprint | null;
  comparedTo: DiffBasis;
}

/** raised when a tool is asked about a sweep or site that does not exist */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * reduces a fingerprint to the counts the model reasons over.
 *
 * the full host and cookie lists never enter the prompt: on a real site they run
 * to hundreds of entries, and the model has a deterministic diff tool for the
 * part of them that matters.
 *
 * @param fingerprint the fingerprint to summarize
 * @returns its counts and identity
 */
export function summarize(fingerprint: Fingerprint): FingerprintSummary {
  return {
    sweepId: fingerprint.sweepId,
    // an absent schemaVersion is generation 1, by definition
    schemaVersion: fingerprint.schemaVersion ?? 1,
    hash: fingerprint.hash,
    hostsCount: fingerprint.hosts.length,
    cookiesCount: fingerprint.cookies.length,
    preConsentNonNecessaryCount: fingerprint.preConsentNonNecessaryCount,
    complianceScore: fingerprint.complianceScore,
    scannedAt: fingerprint.scannedAt,
  };
}

/**
 * loads the site, this sweep's fingerprint, and the two candidate reference
 * points, then decides which one drift is measured against.
 *
 * the approved baseline wins when there is one, because it is the state a human
 * signed off on and every later sweep should be judged against it rather than
 * against yesterday's already-drifted state. it is skipped when it happens to be
 * this very sweep — a re-delivery of the sweep that created the baseline would
 * otherwise diff a fingerprint against itself and report a confident `noop`.
 *
 * @param store the Firestore accessors
 * @param siteId the site under analysis
 * @param sweepId the sweep under analysis
 * @returns the resolved comparison
 * @throws {NotFoundError} when the site or its fingerprint is missing
 */
export async function loadComparison(
  store: Store,
  siteId: string,
  sweepId: string,
): Promise<Comparison> {
  const site = await store.getSite(siteId);
  if (!site) {
    throw new NotFoundError(`no site registered as "${siteId}"`);
  }

  const current = await store.getFingerprint(siteId, sweepId);
  if (!current) {
    throw new NotFoundError(`no fingerprint at sites/${siteId}/fingerprints/${sweepId}`);
  }

  const baselineId = site.approvedBaselineId;
  const baseline =
    baselineId && baselineId !== sweepId ? await store.getFingerprint(siteId, baselineId) : null;
  const previous = await store.getPreviousFingerprint(siteId, current.scannedAt, sweepId);

  if (baseline) {
    return { site, current, baseline, previous, against: baseline, comparedTo: "baseline" };
  }
  if (previous) {
    return { site, current, baseline: null, previous, against: previous, comparedTo: "previous" };
  }
  return { site, current, baseline: null, previous: null, against: null, comparedTo: "none" };
}

/**
 * projects a resolved comparison into the payload `get_sweep_context` returns.
 *
 * @param comparison the resolved comparison
 * @returns the context the model reads
 */
export function toSweepContext(comparison: Comparison): SweepContext {
  const { site, current, baseline, previous } = comparison;
  return {
    site: {
      siteId: site.siteId,
      url: site.url,
      ...(site.ownerEmail ? { ownerEmail: site.ownerEmail } : {}),
      ...(site.approvedBaselineId ? { approvedBaselineId: site.approvedBaselineId } : {}),
    },
    fingerprint: summarize(current),
    baseline: baseline ? summarize(baseline) : null,
    previous: previous ? summarize(previous) : null,
  };
}
