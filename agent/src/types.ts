/**
 * the documents this service reads and writes, and the messages it moves.
 *
 * the fingerprint shape is NOT defined here. it comes from
 * `@pixel-patrol/shared`, which the crawler writes through and this service
 * reads through, because the hand-synced copy that used to live in this file
 * drifted from the crawler's twice — and a drifted fingerprint type does not
 * fail a build, it makes the differ silently stop seeing hosts.
 */

import type { TrackerCategory } from "@pixel-patrol/shared";

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

/**
 * what the analyst judged one newly appeared domain to be.
 *
 * this is the model's contribution to the record, and it is stored apart from
 * the diff for that reason: `hostsAdded` is what the scanner measured, this is
 * what a language model concluded about it. `basis` is not decoration — it has
 * to name what `lookup_host_knowledge` returned, so a reader can see whether a
 * vendor came out of the tables or out of the model, and a classification with
 * nothing behind it is supposed to arrive as `unclassified` at low confidence.
 */
export interface DomainClassification {
  /** the registrable domain, matching an entry in {@link Decision.hostsAdded} */
  domain: string;
  /** the operator behind it, or null when nothing established one */
  vendor: string | null;
  /** a category from the tables' closed set */
  category: TrackerCategory | string;
  confidence: "high" | "medium" | "low";
  /** what in the lookup supports this — a table entry, a near match, or a regex */
  basis: string;
}

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
  /**
   * the analyst's judgement of each added domain. absent on a noop or a
   * baseline, and absent on a drift the model chose not to classify — the
   * redline scribe reads it and falls back to the raw domains, because a
   * missing classification must not stop a finding reaching its owner.
   */
  classifications?: DomainClassification[];
  error?: string;
  at: string;
  model: string;
}

/**
 * one row of a record of processing activities, in the field shape the
 * gdpr-toolkit's RoPA export expects. Czech text, because it is written for a
 * Czech site owner to hand to a Czech supervisory authority.
 */
export interface RopaRow {
  name: string;
  purpose: string;
  legal_basis: string;
  data_categories: string[];
  data_subject_categories: string[];
  recipients: string[];
  retention_period: string;
  third_country_transfers: string;
  is_dpia_required: boolean;
  notes: string;
}

/**
 * the paperwork one drift decision generates, at
 * sites/{siteId}/redlines/{sweepId}.
 *
 * keyed by sweepId like the decision it follows, so a Pub/Sub redelivery
 * rewrites the same document rather than leaving an owner with two conflicting
 * versions of the same edit.
 */
export interface Redline {
  siteId: string;
  sweepId: string;
  /** Czech edit instructions for the site's cookie policy */
  policyRedline: string;
  ropaRow: RopaRow;
  /** the domains the redline was written about, copied from the decision */
  domains: string[];
  at: string;
  model: string;
}

/** one half of a notification, once it has actually landed somewhere */
export interface NotificationDelivery {
  at: string;
}

/** the GitHub issue a drift filed */
export interface IssueDelivery extends NotificationDelivery {
  number: number;
  url: string;
}

/** the owner email a drift sent */
export interface EmailDelivery extends NotificationDelivery {
  id: string;
  to: string;
}

/**
 * what one drift finding was told to the outside world, at
 * sites/{siteId}/notifications/{sweepId}.
 *
 * keyed by sweepId like the decision and the redline, and read before anything
 * is sent: a Pub/Sub redelivery must not file a second ticket or send a second
 * email for a finding the owner has already seen.
 *
 * the two halves are recorded separately on purpose. filing the issue can
 * succeed and the email fail, and a replay then owes the owner exactly the
 * missing half — re-filing the ticket to get the mail out would leave two
 * tickets for one finding.
 */
export interface NotificationRecord {
  siteId: string;
  sweepId: string;
  /** the filed issue, or null when filing has not succeeded yet */
  issue: IssueDelivery | null;
  /** the sent email, or null when sending has not succeeded yet */
  email: EmailDelivery | null;
  /** why the issue is still null, when an attempt failed */
  issueError?: string;
  /** why the email is still null, when an attempt failed */
  emailError?: string;
  /** the domains notified about, copied from the decision */
  domains: string[];
  at: string;
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
