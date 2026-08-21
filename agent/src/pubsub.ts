/**
 * the publish side of the fan-out.
 *
 * a tick produces one `site-sweep` message per site rather than one message
 * listing every site, so a site whose crawl fails is retried and dead-lettered
 * on its own. one bad URL cannot stall or poison the rest of the fleet.
 */

import { PubSub } from "@google-cloud/pubsub";

import type { SiteSweepMessage } from "./types.js";

/** the publishes this service performs */
export interface Publisher {
  publishSiteSweep(message: SiteSweepMessage): Promise<string>;
}

/**
 * builds the publisher.
 *
 * @param projectId the GCP project owning the topic
 * @param topicName the site-sweep topic
 * @returns a publisher bound to that topic
 */
export function createPublisher(projectId: string, topicName: string): Publisher {
  const pubsub = new PubSub({ projectId });
  const topic = pubsub.topic(topicName);

  return {
    /**
     * publishes one sweep request.
     *
     * @returns the Pub/Sub message id
     */
    async publishSiteSweep(message: SiteSweepMessage): Promise<string> {
      return topic.publishMessage({
        data: Buffer.from(JSON.stringify(message), "utf-8"),
        attributes: { siteId: message.siteId, sweepId: message.sweepId },
      });
    },
  };
}

/**
 * mints a sweep id: a compact UTC timestamp plus a short random suffix.
 *
 * the timestamp makes ids sort chronologically in the Firestore console and in
 * a fingerprint listing; the suffix keeps two sweeps started in the same second
 * (a scheduled tick racing an operator's forced re-check) from colliding on the
 * same document.
 *
 * @param now the clock to read, injectable for tests
 * @returns an id of the form `20260821T190455Z-a1b2c3`
 */
export function newSweepId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `${stamp}-${suffix}`;
}
