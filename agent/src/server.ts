/**
 * the HTTP surface: three Pub/Sub push triggers and a small operator API.
 *
 * every trigger is idempotent-ish by construction — a sweep id keys the sweep
 * record and the decision document, so a Pub/Sub redelivery overwrites rather
 * than duplicates. non-2xx means "retry me": that is how a transient Firestore
 * blip or a not-yet-deployed crawler job ends up retried and finally
 * dead-lettered instead of silently dropped.
 *
 * Express over Fastify, for one reason: `@google/adk` already declares Express
 * as a peer dependency, so it is in the tree either way and adding Fastify would
 * mean shipping two HTTP stacks in one image.
 */

import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import pino from "pino";
import type { Logger } from "pino";
import { z } from "zod";

import { analyseSweep, createAnalystRunner } from "./agent.js";
import { createPushVerifier, isValidAdminKey, PushAuthError } from "./auth.js";
import type { PushVerifier } from "./auth.js";
import { readConfig } from "./config.js";
import type { AgentConfig } from "./config.js";
import { createStore } from "./firestore.js";
import type { Store } from "./firestore.js";
import { createPublisher, newSweepId } from "./pubsub.js";
import type { Publisher } from "./pubsub.js";
import { decodePushMessage, PushDecodeError } from "./push-message.js";
import { createJobRunner } from "./run-job.js";
import type { JobRunner } from "./run-job.js";
import { loadComparison, NotFoundError } from "./sweep-context.js";
import type { Decision, SweepDoneMessage } from "./types.js";

// ---------------------------------------------------------------------------
// message validation
// ---------------------------------------------------------------------------

/** the payload the tick fan-out publishes, as read back off `site-sweep` */
const siteSweepSchema = z.object({
  siteId: z.string().min(1),
  siteUrl: z.string().url(),
  sweepId: z.string().min(1),
});

/** the crawler's completion notice, as read off `sweep-done` */
const sweepDoneSchema = z.discriminatedUnion("status", [
  z.object({
    siteId: z.string().min(1),
    sweepId: z.string().min(1),
    status: z.literal("ok"),
    hostsCount: z.number().optional(),
    cookiesCount: z.number().optional(),
    hash: z.string().optional(),
  }),
  z.object({
    siteId: z.string().min(1),
    sweepId: z.string().min(1),
    status: z.literal("failed"),
    error: z.string().optional(),
  }),
]);

/** an operator registering a site */
const registerSiteSchema = z.object({
  siteId: z
    .string()
    .min(1)
    .max(120)
    // the site id is a Firestore document id and appears in every path built
    // from it; keep it to characters that cannot escape a path segment
    .regex(/^[a-z0-9][a-z0-9-]*$/, "siteId must be lowercase alphanumeric with dashes"),
  url: z.string().url(),
  ownerEmail: z.string().email().optional(),
});

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

/** everything the routes need, injectable so the app can be built in a test */
export interface AppDeps {
  config: AgentConfig;
  log: Logger;
  store: Store;
  publisher: Publisher;
  jobs: JobRunner;
  verifier: PushVerifier;
  /** runs the analyst over a finished sweep */
  analyse: (input: { siteId: string; sweepId: string }) => Promise<{
    finalText: string;
    toolCalls: string[];
  }>;
}

/**
 * builds every dependency from a validated config.
 *
 * @param config the validated environment
 * @param log the root logger
 * @returns the wired dependencies
 */
export function createDeps(config: AgentConfig, log: Logger): AppDeps {
  const store = createStore(config.projectId);
  const runner = createAnalystRunner(store, config.model);

  return {
    config,
    log,
    store,
    publisher: createPublisher(config.projectId, config.siteSweepTopic),
    jobs: createJobRunner(config.projectId, config.region, config.crawlerJob),
    verifier: createPushVerifier(`patrol-agent@${config.projectId}.iam.gserviceaccount.com`),
    analyse: (input) => analyseSweep(runner, input),
  };
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

/**
 * builds the Express app.
 *
 * @param deps the wired dependencies
 * @returns the app, ready to listen
 */
export function createApp(deps: AppDeps): Express {
  const { config, log } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  /**
   * gate for a Pub/Sub push route.
   *
   * Cloud Run is deployed --no-allow-unauthenticated, so an unsigned request
   * never reaches this process. the check runs anyway: the platform proves the
   * caller holds run.invoker, this proves the caller is *our* push subscription
   * with a token minted for *this* endpoint. defence in depth, and it keeps the
   * service honest if it is ever run somewhere without the edge check.
   */
  const requirePushAuth = (path: string) => {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      if (!config.selfUrl) {
        log.error({ path }, "SELF_URL is not set; cannot verify push tokens");
        res.status(503).json({ error: "SELF_URL not configured" });
        return;
      }
      try {
        const identity = await deps.verifier.verify(
          req.header("authorization"),
          `${config.selfUrl}${path}`,
        );
        log.debug({ path, caller: identity.email }, "push token verified");
        next();
      } catch (err) {
        if (err instanceof PushAuthError) {
          log.warn({ path, err: err.message }, "push authentication rejected");
          res.status(err.status).json({ error: err.message });
          return;
        }
        next(err);
      }
    };
  };

  /** gate for the operator routes: a shared header, compared in constant time */
  const requireAdminKey = (req: Request, res: Response, next: NextFunction): void => {
    if (!isValidAdminKey(req.header("x-admin-key"), config.adminKey)) {
      log.warn({ path: req.path }, "admin key rejected");
      res.status(401).json({ error: "invalid or missing x-admin-key" });
      return;
    }
    next();
  };

  // -------------------------------------------------------------------------
  // health
  // -------------------------------------------------------------------------

  // two paths, because Google's frontend swallows the exact path /healthz before
  // it reaches a Cloud Run container — it answers its own 404 and the request
  // never appears in the service log. verified on this deployment: /healthz is
  // intercepted, /healthz/ and /health are not. /healthz stays for local runs and
  // for anywhere else this image is hosted; /health is the one to probe on Cloud Run.
  app.get(["/healthz", "/health"], (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, model: config.model, selfUrl: config.selfUrl });
  });

  // -------------------------------------------------------------------------
  // trigger: tick — fan one scheduled tick out to one message per site
  // -------------------------------------------------------------------------

  app.post(
    "/trigger/tick",
    requirePushAuth("/trigger/tick"),
    asyncRoute(async (_req: Request, res: Response) => {
      const sites = await deps.store.listSites();
      const published: string[] = [];
      const skipped: string[] = [];

      for (const site of sites) {
        if (!site.url) {
          skipped.push(site.siteId);
          continue;
        }
        // one message per site, not one message listing every site: a site whose
        // crawl fails then retries and dead-letters alone
        const sweepId = newSweepId();
        await deps.publisher.publishSiteSweep({
          siteId: site.siteId,
          siteUrl: site.url,
          sweepId,
        });
        published.push(site.siteId);
      }

      log.info({ published: published.length, skipped }, "tick fanned out");
      res.status(204).end();
    }, log),
  );

  // -------------------------------------------------------------------------
  // trigger: site-sweep — start one crawl, do not wait for it
  // -------------------------------------------------------------------------

  app.post(
    "/trigger/site-sweep",
    requirePushAuth("/trigger/site-sweep"),
    asyncRoute(async (req: Request, res: Response) => {
      const message = siteSweepSchema.parse(decodePushMessage(req.body).payload);

      const dispatch = await deps.jobs.runCrawl(message);
      await deps.store.recordSweepDispatch(message.siteId, message.sweepId, {
        startedAt: new Date().toISOString(),
        execution: dispatch.execution || dispatch.operation,
      });

      log.info(
        {
          siteId: message.siteId,
          sweepId: message.sweepId,
          execution: dispatch.execution,
          operation: dispatch.operation,
        },
        "crawl execution accepted",
      );
      res.status(204).end();
    }, log),
  );

  // -------------------------------------------------------------------------
  // trigger: sweep-done — the analyst runs here
  // -------------------------------------------------------------------------

  app.post(
    "/trigger/sweep-done",
    requirePushAuth("/trigger/sweep-done"),
    asyncRoute(async (req: Request, res: Response) => {
      const message: SweepDoneMessage = sweepDoneSchema.parse(
        decodePushMessage(req.body).payload,
      ) as SweepDoneMessage;
      const { siteId, sweepId } = message;

      if (message.status === "failed") {
        // no fingerprint was written, so there is nothing to analyse. record the
        // failure as the sweep's outcome so a site that keeps failing is visible
        // in the same place as one that keeps drifting.
        const decision: Decision = {
          siteId,
          sweepId,
          action: "failed",
          summary: "The sweep did not complete, so nothing could be compared.",
          error: message.error ?? "unknown error",
          at: new Date().toISOString(),
          model: config.model,
        };
        await deps.store.writeDecision(decision);
        log.warn({ siteId, sweepId, err: decision.error }, "sweep failed; decision recorded");
        res.status(204).end();
        return;
      }

      // fail fast before spending a model call: if the fingerprint has not landed
      // yet, a 500 sends this back through Pub/Sub's retry rather than letting the
      // agent flounder against a missing document
      await loadComparison(deps.store, siteId, sweepId);

      const started = Date.now();
      const result = await deps.analyse({ siteId, sweepId });

      // the instruction requires exactly one record_decision call; verify it
      // rather than trust it, and retry the whole run if the model skipped it
      const recorded = await deps.store.getDecision(siteId, sweepId);
      if (!recorded) {
        log.error(
          { siteId, sweepId, toolCalls: result.toolCalls, finalText: result.finalText },
          "analyst finished without recording a decision",
        );
        res.status(500).json({ error: "no decision recorded" });
        return;
      }

      log.info(
        {
          siteId,
          sweepId,
          action: recorded.action,
          summary: recorded.summary,
          toolCalls: result.toolCalls,
          finalText: result.finalText,
          durationMs: Date.now() - started,
        },
        "analysis complete",
      );
      res.status(204).end();
    }, log),
  );

  // -------------------------------------------------------------------------
  // operator API
  // -------------------------------------------------------------------------

  app.post(
    "/sites",
    requireAdminKey,
    asyncRoute(async (req: Request, res: Response) => {
      const body = registerSiteSchema.parse(req.body);
      await deps.store.upsertSite({
        siteId: body.siteId,
        url: body.url,
        ...(body.ownerEmail ? { ownerEmail: body.ownerEmail } : {}),
        createdAt: new Date().toISOString(),
      });
      log.info({ siteId: body.siteId, url: body.url }, "site registered");
      res.status(201).json({ siteId: body.siteId, url: body.url });
    }, log),
  );

  app.post(
    "/sites/:siteId/sweep",
    requireAdminKey,
    asyncRoute(async (req: Request, res: Response) => {
      const siteId = String(req.params.siteId);
      const site = await deps.store.getSite(siteId);
      if (!site) {
        res.status(404).json({ error: `no site registered as "${siteId}"` });
        return;
      }

      // the same fan-out path a tick takes, so a forced re-check is retried and
      // dead-lettered on exactly the same terms as a scheduled one
      const sweepId = newSweepId();
      await deps.publisher.publishSiteSweep({ siteId, siteUrl: site.url, sweepId });
      log.info({ siteId, sweepId }, "sweep forced by operator");
      res.status(202).json({ siteId, sweepId });
    }, log),
  );

  app.get(
    "/sites/:siteId/decisions",
    requireAdminKey,
    asyncRoute(async (req: Request, res: Response) => {
      const siteId = String(req.params.siteId);
      const requested = Number(req.query.limit ?? 10);
      const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 100) : 10;
      res.status(200).json({ siteId, decisions: await deps.store.listDecisions(siteId, limit) });
    }, log),
  );

  // -------------------------------------------------------------------------
  // errors
  // -------------------------------------------------------------------------

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // a malformed message or a body that does not match its schema is a poison
    // message: 400 nacks it, Pub/Sub retries a few times and dead-letters it
    if (err instanceof PushDecodeError || err instanceof z.ZodError) {
      log.warn({ path: req.path, err: errorMessage(err) }, "rejected malformed request");
      res.status(400).json({ error: errorMessage(err) });
      return;
    }
    // a missing site or fingerprint on a trigger is usually a race with the
    // crawler's write, so it gets the same 500 as any other failure and rides
    // Pub/Sub's retry rather than being swallowed as a client error
    if (err instanceof NotFoundError) {
      log.warn({ path: req.path, err: err.message }, "referent missing; will be retried");
    } else {
      log.error({ path: req.path, err: errorMessage(err) }, "request failed");
    }
    res.status(500).json({ error: errorMessage(err) });
  });

  return app;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * adapts an async handler to Express, forwarding rejections to the error
 * middleware. Express 5 does this for returned promises already; doing it
 * explicitly keeps the behaviour independent of that version detail.
 */
function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
  log: Logger,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch((err: unknown) => {
      log.debug({ path: req.path }, "handler rejected");
      next(err);
    });
  };
}

/** the message of an unknown thrown value, without assuming it is an Error */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

/** starts the service; exits non-zero if the environment is unusable */
function main(): void {
  const bootLog = pino({ level: process.env.LOG_LEVEL?.trim() || "info" });

  let config: AgentConfig;
  try {
    config = readConfig(process.env);
  } catch (err) {
    bootLog.error({ err: errorMessage(err) }, "agent configuration invalid");
    process.exit(1);
  }

  const log = pino({ level: config.logLevel, base: { service: "patrol-agent" } });
  if (!config.selfUrl) {
    log.warn(
      "SELF_URL is unset — /trigger/* will answer 503 until the deploy script sets it to the service URL",
    );
  }

  const app = createApp(createDeps(config, log));
  app.listen(config.port, () => {
    log.info(
      {
        port: config.port,
        project: config.projectId,
        model: config.model,
        geminiLocation: config.geminiLocation,
        crawlerJob: config.crawlerJob,
      },
      "patrol-agent listening",
    );
  });
}

// only boot when run as the entry point, so tests can import the factories
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
