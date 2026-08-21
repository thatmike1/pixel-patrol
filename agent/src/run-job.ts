/**
 * starting a crawl: the Cloud Run Admin API call behind `infra/run-sweep.sh`.
 *
 * the execution is started and then let go. a crawl takes minutes and a Pub/Sub
 * push request has to be acknowledged in seconds, so waiting for the job would
 * guarantee the delivery times out and gets redelivered, launching the crawl
 * again. the crawler closes the loop itself by publishing to `sweep-done`.
 */

import { JobsClient } from "@google-cloud/run";

/** what a dispatched crawl reports back synchronously */
export interface JobDispatch {
  /** the long-running operation covering this execution */
  operation: string;
  /** the execution resource name, when the API returned it in the operation metadata */
  execution: string;
}

/** the job launches this service performs */
export interface JobRunner {
  runCrawl(input: { siteId: string; siteUrl: string; sweepId: string }): Promise<JobDispatch>;
}

/**
 * builds the Cloud Run job launcher.
 *
 * the client is pinned to the regional endpoint: Cloud Run v2 resources are
 * regional, and the global endpoint does not resolve a job that lives in
 * europe-west1.
 *
 * @param projectId project holding the job
 * @param region region holding the job
 * @param jobName the Cloud Run Job to execute, e.g. `patrol-crawler`
 * @returns a runner bound to that job
 */
export function createJobRunner(
  projectId: string,
  region: string,
  jobName: string,
): JobRunner {
  const client = new JobsClient({ apiEndpoint: `${region}-run.googleapis.com` });
  const name = `projects/${projectId}/locations/${region}/jobs/${jobName}`;

  return {
    async runCrawl(input): Promise<JobDispatch> {
      const [operation] = await client.runJob({
        name,
        overrides: {
          containerOverrides: [
            {
              env: [
                { name: "SITE_ID", value: input.siteId },
                { name: "SITE_URL", value: input.siteUrl },
                { name: "SWEEP_ID", value: input.sweepId },
              ],
            },
          ],
        },
      });

      // deliberately no `await operation.promise()` — that would block until the
      // crawl finishes. the execution name arrives in the operation metadata.
      return {
        operation: operation.name ?? "",
        execution: operation.metadata?.name ?? "",
      };
    },
  };
}
