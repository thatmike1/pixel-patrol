/**
 * fixtures the agent's tests build a site's history out of.
 *
 * shared rather than copied because two suites now need the same in-memory
 * Store: the drift tests, which are about what a sweep is measured against, and
 * the redline tests, which need a site with a recorded drift to document. two
 * fakes would be two Firestore emulations to keep honest, and the ordering
 * rules encoded here are exactly the part that must not quietly diverge.
 *
 * not a `.test.ts` file on purpose — importing one from another would register
 * its tests twice under the runner's glob. it is excluded from the build.
 */

import type { Fingerprint, FingerprintCookie, FingerprintHost } from "@pixel-patrol/shared";

import type { DriftOptions } from "./drift.js";
import type { PendingUpdate, Store } from "./firestore.js";
import type { Decision, Redline, Site, SweepRecord } from "./types.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

export const OPTIONS: DriftOptions = { stabilityWindow: 5, goneAfter: 3 };

/** a host entry whose registrable domain is the hostname */
export function host(domain: string, overrides: Partial<FingerprintHost> = {}): FingerprintHost {
  return {
    host: domain,
    registrableDomain: domain,
    vendor: null,
    category: "unclassified",
    type: "script",
    ...overrides,
  };
}

/** a cookie entry with sane defaults */
export function cookie(name: string, domain: string): FingerprintCookie {
  return {
    name,
    domain,
    path: "/",
    category: "unclassified",
    isFirstParty: false,
    durationSeconds: null,
  };
}

/** minutes-apart sweep timestamps, so `scannedAt` ordering is unambiguous */
export function at(index: number): string {
  return new Date(Date.UTC(2026, 7, 21, 12, index)).toISOString();
}

/** a generation 2 fingerprint */
export function fingerprint(
  sweepId: string,
  minute: number,
  hosts: FingerprintHost[],
  cookies: FingerprintCookie[] = [],
  overrides: Partial<Fingerprint> = {},
): Fingerprint {
  return {
    schemaVersion: 2,
    siteId: "smoke",
    sweepId,
    siteUrl: "https://example.test",
    scannedAt: at(minute),
    pagesScanned: 5,
    hosts,
    cookies,
    preConsentNonNecessaryCount: 0,
    complianceScore: 100,
    hash: `hash-${sweepId}`,
    ...overrides,
  };
}

/** what a fake store recorded, for assertions */
export interface Recorded {
  decisions: Decision[];
  pending: PendingUpdate[];
  approvals: string[];
  redlines: Redline[];
}

/**
 * an in-memory Store.
 *
 * it implements the same queries Firestore does, including the ordering and the
 * "strictly before" bound, because those are the parts the window depends on.
 */
export function fakeStore(
  site: Site | null,
  fingerprints: Fingerprint[],
): { store: Store; recorded: Recorded } {
  const recorded: Recorded = { decisions: [], pending: [], approvals: [], redlines: [] };
  let current = site;

  const store: Store = {
    async listSites() {
      return current ? [current] : [];
    },
    async getSite() {
      return current;
    },
    async upsertSite(next) {
      current = { ...(current ?? next), ...next };
    },
    async setApprovedBaseline(_siteId, sweepId) {
      recorded.approvals.push(sweepId);
      if (current) {
        current = { ...current, approvedBaselineId: sweepId };
        delete current.pendingDomains;
        delete current.pendingCookies;
        delete current.pendingSweepId;
      }
    },
    async setPending(_siteId, update) {
      recorded.pending.push(update);
      if (current) {
        current = {
          ...current,
          pendingDomains: [...new Set([...(current.pendingDomains ?? []), ...update.domains])],
          pendingCookies: [...new Set([...(current.pendingCookies ?? []), ...update.cookies])],
          pendingSweepId: update.sweepId,
        };
      }
    },
    async getFingerprint(_siteId, sweepId) {
      return fingerprints.find((fp) => fp.sweepId === sweepId) ?? null;
    },
    async listFingerprintsBefore(_siteId, before, limit, excludeSweepId) {
      return fingerprints
        .filter((fp) => fp.scannedAt < before && fp.sweepId !== excludeSweepId)
        .sort((a, b) => (a.scannedAt < b.scannedAt ? 1 : -1))
        .slice(0, limit);
    },
    async recordSweepDispatch(_siteId: string, _sweepId: string, _record: SweepRecord) {},
    async writeDecision(decision) {
      recorded.decisions.push(decision);
    },
    async getDecision(_siteId, sweepId) {
      return recorded.decisions.find((d) => d.sweepId === sweepId) ?? null;
    },
    async listDecisions(_siteId, limit) {
      return recorded.decisions.slice(-limit).reverse();
    },
    async writeRedline(redline) {
      // keyed by sweepId in Firestore, so a rewrite replaces rather than appends
      const index = recorded.redlines.findIndex((r) => r.sweepId === redline.sweepId);
      if (index >= 0) recorded.redlines[index] = redline;
      else recorded.redlines.push(redline);
    },
    async getRedline(_siteId, sweepId) {
      return recorded.redlines.find((r) => r.sweepId === sweepId) ?? null;
    },
    async listRedlines(_siteId, limit) {
      return recorded.redlines.slice(-limit).reverse();
    },
  };

  return { store, recorded };
}
