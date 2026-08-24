/**
 * typed accessors over the Firestore layout.
 *
 *   sites/{siteId}
 *     fingerprints/{sweepId}   written by the crawler, never by this service
 *     sweeps/{sweepId}         dispatch record: when we asked for the crawl
 *     decisions/{sweepId}      what the analyst concluded
 *     redlines/{sweepId}       the policy edit and RoPA row a drift decision produced
 *     notifications/{sweepId}  what was filed and mailed about that drift
 *
 * every read that crosses into the model goes through here, so the shapes the
 * tools hand to Gemini are the shapes this file returns and nothing wider.
 * authentication is Application Default Credentials: locally
 * `gcloud auth application-default login`, on Cloud Run the service account.
 */

import { FieldValue, Firestore } from "@google-cloud/firestore";

import type {
  Decision,
  Fingerprint,
  NotificationRecord,
  Redline,
  Site,
  SweepRecord,
} from "./types.js";

/** the entries a sweep reported and parked for a human to accept or reject */
export interface PendingUpdate {
  domains: string[];
  cookies: string[];
  /** the sweep that produced them, so its own re-analysis is not suppressed */
  sweepId: string;
}

/** the reads and writes the service performs, bound to one project */
export interface Store {
  listSites(): Promise<Site[]>;
  getSite(siteId: string): Promise<Site | null>;
  upsertSite(site: Site): Promise<void>;
  /** approves a baseline and clears the pending sets it settles */
  setApprovedBaseline(siteId: string, sweepId: string): Promise<void>;
  /** parks the entries a sweep reported, so the next sweep does not repeat them */
  setPending(siteId: string, update: PendingUpdate): Promise<void>;
  getFingerprint(siteId: string, sweepId: string): Promise<Fingerprint | null>;
  /** the most recent fingerprints scanned strictly before `before`, newest first */
  listFingerprintsBefore(
    siteId: string,
    before: string,
    limit: number,
    excludeSweepId: string,
  ): Promise<Fingerprint[]>;
  recordSweepDispatch(siteId: string, sweepId: string, record: SweepRecord): Promise<void>;
  writeDecision(decision: Decision): Promise<void>;
  getDecision(siteId: string, sweepId: string): Promise<Decision | null>;
  listDecisions(siteId: string, limit: number): Promise<Decision[]>;
  writeRedline(redline: Redline): Promise<void>;
  getRedline(siteId: string, sweepId: string): Promise<Redline | null>;
  listRedlines(siteId: string, limit: number): Promise<Redline[]>;
  writeNotification(notification: NotificationRecord): Promise<void>;
  getNotification(siteId: string, sweepId: string): Promise<NotificationRecord | null>;
}

/**
 * the document patch that parks a sweep's findings.
 *
 * an empty side is omitted rather than written: `FieldValue.arrayUnion()`
 * refuses to be called with nothing to add, and a drift in domains only — the
 * common case — would otherwise throw here, after the decision had already been
 * written.
 *
 * @param update the keys to park and the sweep that found them
 * @returns the merge patch for the site document
 */
export function pendingFields(update: PendingUpdate): Record<string, unknown> {
  return {
    ...(update.domains.length > 0
      ? { pendingDomains: FieldValue.arrayUnion(...update.domains) }
      : {}),
    ...(update.cookies.length > 0
      ? { pendingCookies: FieldValue.arrayUnion(...update.cookies) }
      : {}),
    pendingSweepId: update.sweepId,
  };
}

/**
 * builds the Firestore accessors for a project.
 *
 * @param projectId the GCP project holding the default Firestore database
 * @returns the store, with one client shared by every call
 */
export function createStore(projectId: string): Store {
  const db = new Firestore({ projectId });
  const sites = db.collection("sites");

  return {
    async listSites(): Promise<Site[]> {
      const snapshot = await sites.get();
      return snapshot.docs.map((doc) => ({ ...(doc.data() as Omit<Site, "siteId">), siteId: doc.id }));
    },

    async getSite(siteId: string): Promise<Site | null> {
      const doc = await sites.doc(siteId).get();
      if (!doc.exists) return null;
      return { ...(doc.data() as Omit<Site, "siteId">), siteId: doc.id };
    },

    /**
     * registers or updates a site. merged, because the crawler writes
     * `lastSweepId` onto the same document and must not be clobbered by an
     * operator re-registering the URL.
     */
    async upsertSite(site: Site): Promise<void> {
      const { siteId, ...fields } = site;
      await sites.doc(siteId).set(fields, { merge: true });
    },

    /**
     * points the site at a baseline and empties the pending sets.
     *
     * approving a baseline IS the decision the pending entries were waiting
     * for: whatever was in them is now part of the approved state, or was
     * removed from it. leaving them behind would suppress a future alert on the
     * same domain forever.
     */
    async setApprovedBaseline(siteId: string, sweepId: string): Promise<void> {
      await sites.doc(siteId).set(
        {
          approvedBaselineId: sweepId,
          pendingDomains: FieldValue.delete(),
          pendingCookies: FieldValue.delete(),
          pendingSweepId: FieldValue.delete(),
        },
        { merge: true },
      );
    },

    /**
     * records what a sweep reported, so the next one reports it as pending
     * rather than as a fresh finding. accumulative: a later sweep's findings are
     * added to what is already parked, never replace it.
     */
    async setPending(siteId: string, update: PendingUpdate): Promise<void> {
      await sites.doc(siteId).set(pendingFields(update), { merge: true });
    },

    async getFingerprint(siteId: string, sweepId: string): Promise<Fingerprint | null> {
      const doc = await sites.doc(siteId).collection("fingerprints").doc(sweepId).get();
      return doc.exists ? (doc.data() as Fingerprint) : null;
    },

    /**
     * the newest fingerprints scanned strictly before the one under analysis.
     *
     * "before", not merely "other than": a redelivered or late `sweep-done` for
     * an older sweep would otherwise be compared against a newer fingerprint and
     * report every delta backwards — a tracker that was added would read as one
     * that had been removed.
     *
     * ordered by `scannedAt` rather than document id, because a manually forced
     * sweep can carry any id and would sort into the wrong place. one query
     * serves both the previous fingerprint and the stability window, so the
     * analyst does not pay for two round trips to read overlapping documents.
     */
    async listFingerprintsBefore(
      siteId: string,
      before: string,
      limit: number,
      excludeSweepId: string,
    ): Promise<Fingerprint[]> {
      const snapshot = await sites
        .doc(siteId)
        .collection("fingerprints")
        .where("scannedAt", "<", before)
        .orderBy("scannedAt", "desc")
        // one spare, so excluding the current sweep cannot shorten the window
        .limit(limit + 1)
        .get();

      return snapshot.docs
        .filter((doc) => doc.id !== excludeSweepId)
        .slice(0, limit)
        .map((doc) => doc.data() as Fingerprint);
    },

    async recordSweepDispatch(
      siteId: string,
      sweepId: string,
      record: SweepRecord,
    ): Promise<void> {
      await sites.doc(siteId).collection("sweeps").doc(sweepId).set(record, { merge: false });
    },

    /**
     * writes the analyst's verdict. keyed by sweepId, so a Pub/Sub redelivery
     * overwrites the previous verdict instead of appending a duplicate.
     */
    async writeDecision(decision: Decision): Promise<void> {
      await sites
        .doc(decision.siteId)
        .collection("decisions")
        .doc(decision.sweepId)
        .set(decision, { merge: false });
    },

    async getDecision(siteId: string, sweepId: string): Promise<Decision | null> {
      const doc = await sites.doc(siteId).collection("decisions").doc(sweepId).get();
      return doc.exists ? (doc.data() as Decision) : null;
    },

    /**
     * writes the paperwork for one drift decision. keyed by sweepId for the
     * same reason the decision is: the scribe runs again on a redelivery, and
     * an owner must not end up with two redlines for one finding.
     */
    async writeRedline(redline: Redline): Promise<void> {
      await sites
        .doc(redline.siteId)
        .collection("redlines")
        .doc(redline.sweepId)
        .set(redline, { merge: false });
    },

    async getRedline(siteId: string, sweepId: string): Promise<Redline | null> {
      const doc = await sites.doc(siteId).collection("redlines").doc(sweepId).get();
      return doc.exists ? (doc.data() as Redline) : null;
    },

    async listRedlines(siteId: string, limit: number): Promise<Redline[]> {
      const snapshot = await sites
        .doc(siteId)
        .collection("redlines")
        .orderBy("at", "desc")
        .limit(limit)
        .get();
      return snapshot.docs.map((doc) => doc.data() as Redline);
    },

    /**
     * records what a drift was told to the outside world. keyed by sweepId, and
     * written whole rather than merged: the record is rebuilt from what already
     * landed plus what this attempt achieved, so a merge would only make it
     * possible for a stale half to survive.
     */
    async writeNotification(notification: NotificationRecord): Promise<void> {
      await sites
        .doc(notification.siteId)
        .collection("notifications")
        .doc(notification.sweepId)
        .set(notification, { merge: false });
    },

    async getNotification(siteId: string, sweepId: string): Promise<NotificationRecord | null> {
      const doc = await sites.doc(siteId).collection("notifications").doc(sweepId).get();
      return doc.exists ? (doc.data() as NotificationRecord) : null;
    },

    async listDecisions(siteId: string, limit: number): Promise<Decision[]> {
      const snapshot = await sites
        .doc(siteId)
        .collection("decisions")
        .orderBy("at", "desc")
        .limit(limit)
        .get();
      return snapshot.docs.map((doc) => doc.data() as Decision);
    },
  };
}
