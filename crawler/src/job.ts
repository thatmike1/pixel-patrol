/**
 * Cloud Run Job entry point — one process, one site, one sweep.
 *
 *   env -> crawl -> fingerprint -> Firestore -> Pub/Sub -> exit
 *
 * the job is the unit of retry: it either lands a complete fingerprint and
 * announces it, or it announces a failure and exits non-zero. it never
 * half-writes, and it always publishes something so the sweep does not hang
 * downstream waiting on a message that will never come.
 */

import pino from "pino";
import type { Logger } from "pino";

import { crawlSite } from "./crawler.js";
import { buildFingerprint } from "./fingerprint.js";
import { createSinks } from "./sinks.js";
import type { SweepDoneMessage } from "./sinks.js";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** hard wall-clock budget for the crawl — the abort signal fires at this point */
const CRAWL_TIMEOUT_MS = 8 * 60 * 1000;

/**
 * extra time the crawl gets to wind down after the abort fires before the job
 * gives up on it entirely. the crawler only checks the signal between pages,
 * so it needs roughly one page timeout to notice; past that something is stuck
 * and the job should fail loudly rather than burn the Cloud Run task budget.
 */
const CRAWL_ABORT_GRACE_MS = 60 * 1000;

/** default number of pages to visit when PAGES_TO_SCAN is not set */
const DEFAULT_PAGES_TO_SCAN = 5;

/** default Pub/Sub topic for the sweep-done notification */
const DEFAULT_SWEEP_DONE_TOPIC = "sweep-done";

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

/** the fully validated environment contract for one job run */
interface JobConfig {
  siteId: string;
  siteUrl: string;
  sweepId: string;
  projectId: string;
  pagesToScan: number;
  sweepDoneTopic: string;
  logLevel: string;
}

/**
 * reads and validates the environment. throws with a single message listing
 * every problem, so a misconfigured job tells you all of it on the first run
 * instead of one variable per attempt.
 */
export function readConfig(env: NodeJS.ProcessEnv): JobConfig {
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      problems.push(`${name} is required`);
      return "";
    }
    return value;
  };

  const siteId = required("SITE_ID");
  const siteUrl = required("SITE_URL");
  const sweepId = required("SWEEP_ID");
  const projectId = required("GOOGLE_CLOUD_PROJECT");

  let pagesToScan = DEFAULT_PAGES_TO_SCAN;
  const rawPages = env.PAGES_TO_SCAN?.trim();
  if (rawPages) {
    const parsed = Number(rawPages);
    if (!Number.isInteger(parsed) || parsed < 1) {
      problems.push(`PAGES_TO_SCAN must be a positive integer, got "${rawPages}"`);
    } else {
      pagesToScan = parsed;
    }
  }

  if (problems.length > 0) {
    throw new Error(`invalid environment: ${problems.join("; ")}`);
  }

  return {
    siteId,
    siteUrl,
    sweepId,
    projectId,
    pagesToScan,
    sweepDoneTopic: env.SWEEP_DONE_TOPIC?.trim() || DEFAULT_SWEEP_DONE_TOPIC,
    logLevel: env.LOG_LEVEL?.trim() || "info",
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  // logs go to stdout as JSON lines; sync so nothing is lost to process.exit
  const bootLog = pino(
    { level: process.env.LOG_LEVEL?.trim() || "info" },
    pino.destination({ dest: 1, sync: true }),
  );

  let config: JobConfig;
  try {
    config = readConfig(process.env);
  } catch (err) {
    // nothing to publish to — we may not even know the project or the sweep
    bootLog.error({ err: errorMessage(err) }, "job configuration invalid");
    return 1;
  }

  const log: Logger = pino(
    {
      level: config.logLevel,
      base: {
        siteId: config.siteId,
        sweepId: config.sweepId,
      },
    },
    pino.destination({ dest: 1, sync: true }),
  );

  const sinks = createSinks({
    projectId: config.projectId,
    topicName: config.sweepDoneTopic,
  });

  const publish = async (message: SweepDoneMessage): Promise<void> => {
    try {
      const messageId = await sinks.publishSweepDone(message);
      log.info({ messageId, status: message.status }, "sweep-done published");
    } catch (err) {
      log.error(
        { err: errorMessage(err), status: message.status },
        "failed to publish sweep-done",
      );
    }
  };

  const startedAt = Date.now();
  log.info(
    {
      siteUrl: config.siteUrl,
      pagesToScan: config.pagesToScan,
      topic: config.sweepDoneTopic,
    },
    "sweep starting",
  );

  try {
    const result = await runCrawl(config, log);

    const fingerprint = buildFingerprint(result, {
      siteId: config.siteId,
      sweepId: config.sweepId,
      siteUrl: config.siteUrl,
      scannedAt: new Date().toISOString(),
    });

    await sinks.writeFingerprint(fingerprint);
    log.info(
      {
        hosts: fingerprint.hosts.length,
        cookies: fingerprint.cookies.length,
        hash: fingerprint.hash,
        pagesScanned: fingerprint.pagesScanned,
      },
      "fingerprint written",
    );

    await publish({
      siteId: config.siteId,
      sweepId: config.sweepId,
      status: "ok",
      hostsCount: fingerprint.hosts.length,
      cookiesCount: fingerprint.cookies.length,
      hash: fingerprint.hash,
    });

    log.info({ durationMs: Date.now() - startedAt }, "sweep complete");
    return 0;
  } catch (err) {
    const message = errorMessage(err);
    log.error({ err: message, durationMs: Date.now() - startedAt }, "sweep failed");

    await publish({
      siteId: config.siteId,
      sweepId: config.sweepId,
      status: "failed",
      error: message,
    });

    return 1;
  }
}

/**
 * runs the crawl under a hard wall-clock budget: the abort signal fires at
 * CRAWL_TIMEOUT_MS, and if the crawl has not settled CRAWL_ABORT_GRACE_MS
 * after that, the job stops waiting on it.
 */
async function runCrawl(config: JobConfig, log: Logger) {
  const controller = new AbortController();

  const abortTimer = setTimeout(() => {
    log.warn({ timeoutMs: CRAWL_TIMEOUT_MS }, "crawl budget exhausted, aborting");
    controller.abort();
  }, CRAWL_TIMEOUT_MS);

  let graceTimer: NodeJS.Timeout | undefined;
  const failsafe = new Promise<never>((_resolve, reject) => {
    graceTimer = setTimeout(
      () => reject(new Error("crawl did not stop after abort")),
      CRAWL_TIMEOUT_MS + CRAWL_ABORT_GRACE_MS,
    );
  });

  try {
    return await Promise.race([
      crawlSite(
        {
          siteUrl: config.siteUrl,
          siteId: config.siteId,
          scanJobId: config.sweepId,
          pagesToScan: config.pagesToScan,
          signal: controller.signal,
        },
        log,
      ),
      failsafe,
    ]);
  } finally {
    clearTimeout(abortTimer);
    if (graceTimer) clearTimeout(graceTimer);
  }
}

/** unwraps an unknown thrown value into a loggable string */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Playwright can leave handles open; exit explicitly so the task does not idle
const exitCode = await main();
process.exit(exitCode);
