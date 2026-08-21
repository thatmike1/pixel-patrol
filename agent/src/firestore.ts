/**
 * typed accessors over the Firestore layout.
 *
 *   sites/{siteId}
 *     fingerprints/{sweepId}   written by the crawler, never by this service
 *     sweeps/{sweepId}         dispatch record: when we asked for the crawl
 *     decisions/{sweepId}      what the analyst concluded
 *
 * every read that crosses into the model goes through here, so the shapes the
 * tools hand to Gemini are the shapes this file returns and nothing wider.
 * authentication is Application Default Credentials: locally
 * `gcloud auth application-default login`, on Cloud Run the service account.
 */

import { Firestore } from "@google-cloud/firestore";

import type { Decision, Fingerprint, Site, SweepRecord } from "./types.js";

/** the reads and writes the service performs, bound to one project */
export interface Store {
  listSites(): Promise<Site[]>;
  getSite(siteId: string): Promise<Site | null>;
  upsertSite(site: Site): Promise<void>;
  setApprovedBaseline(siteId: string, sweepId: string): Promise<void>;
  getFingerprint(siteId: string, sweepId: string): Promise<Fingerprint | null>;
  /** the most recent fingerprint scanned strictly before `before` */
  getPreviousFingerprint(
    siteId: string,
    before: string,
    excludeSweepId: string,
  ): Promise<Fingerprint | null>;
  recordSweepDispatch(siteId: string, sweepId: string, record: SweepRecord): Promise<void>;
  writeDecision(decision: Decision): Promise<void>;
  getDecision(siteId: string, sweepId: string): Promise<Decision | null>;
  listDecisions(siteId: string, limit: number): Promise<Decision[]>;
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

    async setApprovedBaseline(siteId: string, sweepId: string): Promise<void> {
      await sites.doc(siteId).set({ approvedBaselineId: sweepId }, { merge: true });
    },

    async getFingerprint(siteId: string, sweepId: string): Promise<Fingerprint | null> {
      const doc = await sites.doc(siteId).collection("fingerprints").doc(sweepId).get();
      return doc.exists ? (doc.data() as Fingerprint) : null;
    },

    /**
     * the newest fingerprint scanned strictly before the one under analysis.
     *
     * "before", not merely "other than": a redelivered or late `sweep-done` for
     * an older sweep would otherwise be compared against a newer fingerprint and
     * report every delta backwards — a tracker that was added would read as one
     * that had been removed.
     *
     * ordered by `scannedAt` rather than document id, because a manually forced
     * sweep can carry any id and would sort into the wrong place.
     */
    async getPreviousFingerprint(
      siteId: string,
      before: string,
      excludeSweepId: string,
    ): Promise<Fingerprint | null> {
      const snapshot = await sites
        .doc(siteId)
        .collection("fingerprints")
        .where("scannedAt", "<", before)
        .orderBy("scannedAt", "desc")
        .limit(2)
        .get();

      for (const doc of snapshot.docs) {
        if (doc.id !== excludeSweepId) return doc.data() as Fingerprint;
      }
      return null;
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
