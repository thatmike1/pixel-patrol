/**
 * the documents this service reads and writes, and the messages it moves.
 *
 * the fingerprint shape is NOT defined here. it comes from
 * `@pixel-patrol/shared`, which the crawler writes through and this service
 * reads through, because the hand-synced copy that used to live in this file
 * drifted from the crawler's twice — and a drifted fingerprint type does not
 * fail a build, it makes the differ silently stop seeing hosts.
 */

export type {
  CookieCategory,
  Fingerprint,
  FingerprintCookie,
  FingerprintHost,
  TrackerCategory,
  TrackerType,
} from "@pixel-patrol/shared";

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
  /**
   * registrable domains already reported as drift and not yet approved into a
   * baseline. an hourly sweep would otherwise re-report the same finding every
   * hour until someone acted on it, which is how an owner learns to ignore the
   * alerts. cleared when a baseline is approved.
   */
  pendingDomains?: string[];
  /** cookie keys (`domain name`) already reported; see {@link Site.pendingDomains} */
  pendingCookies?: string[];
  /**
   * the sweep that last wrote the pending sets.
   *
   * a Pub/Sub redelivery re-analyses a sweep that already recorded drift, and
   * its own findings are sitting in pending by then. without this, the second
   * pass would suppress them and overwrite the drift verdict with a noop.
   */
  pendingSweepId?: string;
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
  /**
   * registrable domains, not hostnames — the unit the diff works in. a sharded
   * CDN that adds a tracker under a rotating subdomain must record the same
   * string on every sweep, or downstream ticket de-duplication sees a new
   * finding each time.
   */
  hostsAdded?: string[];
  hostsRemoved?: string[];
  /**
   * how many differences the stability window explained away as rotation,
   * one-off absences or already-reported findings. a noop with a noiseCount of
   * 30 is the watchdog working, not the watchdog asleep, and the number is what
   * makes that visible in the decision log.
   */
  noiseCount?: number;
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
