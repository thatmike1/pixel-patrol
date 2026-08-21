/**
 * output sinks — Firestore for the fingerprint itself, Pub/Sub for the
 * "this sweep is done" notification that wakes the differ downstream.
 *
 * both clients authenticate with Application Default Credentials. no key
 * files: locally that is `gcloud auth application-default login`, on Cloud
 * Run it is the job's service account.
 */

import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";

import type { Fingerprint } from "./fingerprint.js";

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

/**
 * the Pub/Sub payload published once per sweep, success or failure.
 * discriminated on `status` so consumers cannot read `hash` off a failed sweep.
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

/** what a sink bundle needs to address the right project and topic */
export interface SinkOptions {
  projectId: string;
  topicName: string;
}

/** the two writes a sweep performs, bound to one project */
export interface Sinks {
  writeFingerprint(fp: Fingerprint): Promise<void>;
  publishSweepDone(message: SweepDoneMessage): Promise<string>;
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

/**
 * constructs the Firestore and Pub/Sub clients once and returns the two write
 * operations bound to them. built before the crawl starts so a failure message
 * can still be published when the crawl itself throws.
 */
export function createSinks(options: SinkOptions): Sinks {
  const firestore = new Firestore({ projectId: options.projectId });
  const pubsub = new PubSub({ projectId: options.projectId });

  return {
    /**
     * writes the fingerprint document and updates the site's pointer to it.
     *
     * the fingerprint is written with merge:false — a sweep document is
     * immutable and complete, never a patch over a previous one. the parent
     * site document is merged so that fields owned elsewhere survive.
     */
    async writeFingerprint(fp: Fingerprint): Promise<void> {
      const siteRef = firestore.collection("sites").doc(fp.siteId);

      await siteRef
        .collection("fingerprints")
        .doc(fp.sweepId)
        .set(fp, { merge: false });

      await siteRef.set(
        {
          url: fp.siteUrl,
          lastSweepId: fp.sweepId,
          lastSweepAt: fp.scannedAt,
        },
        { merge: true },
      );
    },

    /**
     * publishes the sweep-done notification. returns the Pub/Sub message id.
     */
    async publishSweepDone(message: SweepDoneMessage): Promise<string> {
      return pubsub.topic(options.topicName).publishMessage({
        data: Buffer.from(JSON.stringify(message), "utf-8"),
      });
    },
  };
}
