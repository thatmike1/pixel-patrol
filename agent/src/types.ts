/**
 * the documents this service reads and writes, and the messages it moves.
 *
 * the fingerprint types are a verbatim copy of `crawler/src/fingerprint.ts` and
 * `crawler/src/types.ts` rather than an import. the two packages build and ship
 * as separate containers — `gcloud builds submit agent` only uploads `agent/`,
 * so a relative import across the package boundary compiles locally and then
 * fails inside Docker. if the shape here drifts from the crawler's, the diff
 * silently stops seeing hosts; the crawler's file is the source of truth.
 */

// ---------------------------------------------------------------------------
// fingerprint — mirrors crawler/src/fingerprint.ts
// ---------------------------------------------------------------------------

/** cookie category — mirrors crawler/src/types.ts */
export type CookieCategory =
  | "necessary"
  | "analytics"
  | "marketing"
  | "functional"
  | "unclassified";

/** tracker category — mirrors crawler/src/types.ts; trackers are never `necessary` */
export type TrackerCategory = "analytics" | "marketing" | "functional" | "unclassified";

/** tracker resource type — mirrors crawler/src/types.ts */
export type TrackerType = "script" | "pixel" | "iframe" | "font";

/** a third-party host observed loading resources on the site */
export interface FingerprintHost {
  host: string;
  vendor: string | null;
  category: TrackerCategory;
  type: TrackerType;
}

/** a cookie observed during the sweep — identity and metadata only, never a value */
export interface FingerprintCookie {
  name: string;
  domain: string;
  path: string;
  category: CookieCategory;
  isFirstParty: boolean;
  durationSeconds: number | null;
}

/** one sweep's snapshot of a site, stored at sites/{siteId}/fingerprints/{sweepId} */
export interface Fingerprint {
  siteId: string;
  sweepId: string;
  siteUrl: string;
  scannedAt: string;
  pagesScanned: number;
  hosts: FingerprintHost[];
  cookies: FingerprintCookie[];
  preConsentNonNecessaryCount: number;
  complianceScore: number;
  hash: string;
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

/** the site document at sites/{siteId} */
export interface Site {
  siteId: string;
  url: string;
  ownerEmail?: string;
  /**
   * sweepId of the fingerprint a human accepted as correct. drift is measured
   * against this when it is set, and against the previous sweep when it is not.
   */
  approvedBaselineId?: string;
  lastSweepId?: string;
  lastSweepAt?: string;
  createdAt?: string;
}

/** the record of a dispatched sweep at sites/{siteId}/sweeps/{sweepId} */
export interface SweepRecord {
  startedAt: string;
  /** the Cloud Run execution resource name, for tracing a sweep back to its logs */
  execution: string;
}

/** what the analyst concluded about one sweep */
export type DecisionAction = "noop" | "drift" | "baseline-created" | "failed";

/** the decision document at sites/{siteId}/decisions/{sweepId} */
export interface Decision {
  siteId: string;
  sweepId: string;
  action: DecisionAction;
  summary: string;
  hostsAdded?: string[];
  hostsRemoved?: string[];
  error?: string;
  at: string;
  model: string;
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

/** one site's slot in a tick fan-out, published to `site-sweep` */
export interface SiteSweepMessage {
  siteId: string;
  siteUrl: string;
  sweepId: string;
}

/**
 * published by the crawler to `sweep-done`. mirrors `SweepDoneMessage` in
 * crawler/src/sinks.ts — discriminated on `status` so a failed sweep cannot be
 * read for a hash it never produced.
 */
export type SweepDoneMessage =
  | {
      siteId: string;
      sweepId: string;
      status: "ok";
      hostsCount: number;
      cookiesCount: number;
      hash: string;
    }
  | {
      siteId: string;
      sweepId: string;
      status: "failed";
      error: string;
    };
