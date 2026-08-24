/**
 * `record_decision` — the only durable output of a run.
 *
 * the analyst's prose answer is logged and then thrown away; this document is
 * what the dashboard, the ticket and the owner email will read. the instruction
 * requires exactly one call, so the tool reports back what it wrote and the
 * model has nothing left to do afterwards.
 *
 * recording drift also parks the alerting entries in the site's pending sets, so
 * an hourly sweep reports a finding once rather than every hour until someone
 * acts on it. what gets parked is recomputed here rather than taken from the
 * model's arguments: the dedupe key has to be exactly the key the classifier
 * alerted on, or the next sweep will not recognise it.
 */

import { FunctionTool } from "@google/adk";
import { alertKeys } from "@pixel-patrol/shared";
import { z } from "zod";

import { analyseDrift, verdictOf } from "../drift.js";
import type { DriftOptions } from "../drift.js";
import type { Store } from "../firestore.js";
import type { Decision } from "../types.js";

/** the arguments the model supplies */
const parameters = z.object({
  siteId: z.string().describe("the site under analysis"),
  sweepId: z.string().describe("the sweep that just finished"),
  action: z
    .enum(["noop", "drift", "baseline-created"])
    .describe(
      "noop when the alerts lists were all empty, drift when any alert list had an entry, " +
        "baseline-created when this sweep became the site's approved baseline",
    ),
  summary: z.string().describe("one sentence a non-technical site owner would understand"),
  hostsAdded: z
    .array(z.string())
    .optional()
    .describe("registrableDomain values from alerts.hostsAdded; omit when none"),
  hostsRemoved: z
    .array(z.string())
    .optional()
    .describe("registrableDomain values from alerts.hostsRemoved; omit when none"),
  noiseCount: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("the noiseCount the diff returned — differences the window explained away"),
  classifications: z
    .array(
      z.object({
        domain: z.string().describe("a registrableDomain from alerts.hostsAdded"),
        vendor: z
          .string()
          .nullable()
          .describe("the operator behind it, or null when the lookup established none"),
        category: z
          .string()
          .describe("one of the categories lookup_host_knowledge returned, or 'unclassified'"),
        confidence: z
          .enum(["high", "medium", "low"])
          .describe("high only for a table entry, medium for a near match, low for a heuristic or nothing"),
        basis: z
          .string()
          .describe("what in the lookup result supports this, named specifically"),
      }),
    )
    .optional()
    .describe("one entry per added domain, from lookup_host_knowledge; omit when nothing was added"),
});

/** what the tool confirms back to the model */
export interface RecordDecisionResult {
  ok: true;
  path: string;
}

/** the verdict as the model reports it */
export type RecordDecisionArgs = z.infer<typeof parameters>;

/**
 * writes the decision and parks whatever it alerted on.
 *
 * separate from the tool wrapper so the pending bookkeeping — the part that
 * decides whether tomorrow's sweep repeats today's finding — can be tested
 * without an LLM or the ADK's tool plumbing.
 *
 * @param store the Firestore accessors
 * @param model the model id stamped on the decision
 * @param options the stability window rules
 * @param args the verdict the analyst reported
 * @returns where the decision was written
 */
export async function recordDecision(
  store: Store,
  model: string,
  options: DriftOptions,
  args: RecordDecisionArgs,
): Promise<RecordDecisionResult> {
  // the counts and the dedupe keys come from the classifier, not from the
  // model's retyping of them. a baseline-created run is exempt: the baseline it
  // just approved is this very sweep, so there is nothing to recompute against.
  const verdict =
    args.action === "baseline-created"
      ? null
      : verdictOf(await analyseDrift(store, args.siteId, args.sweepId, options));

  const decision: Decision = {
    siteId: args.siteId,
    sweepId: args.sweepId,
    action: args.action,
    summary: args.summary,
    ...(args.hostsAdded?.length ? { hostsAdded: args.hostsAdded } : {}),
    ...(args.hostsRemoved?.length ? { hostsRemoved: args.hostsRemoved } : {}),
    // the classifications pass through as the model wrote them: unlike the
    // counts and the dedupe keys, there is no deterministic version of this to
    // recompute against, which is the whole reason `basis` is required
    ...(args.classifications?.length ? { classifications: args.classifications } : {}),
    noiseCount: verdict ? verdict.noiseCount : (args.noiseCount ?? 0),
    at: new Date().toISOString(),
    model,
  };

  await store.writeDecision(decision);

  if (args.action === "drift" && verdict) {
    const keys = alertKeys(verdict);
    if (keys.domains.length > 0 || keys.cookies.length > 0) {
      await store.setPending(args.siteId, { ...keys, sweepId: args.sweepId });
    }
  }

  return { ok: true, path: `sites/${args.siteId}/decisions/${args.sweepId}` };
}

/**
 * builds the tool bound to a store.
 *
 * @param store the Firestore accessors
 * @param model the model id stamped on the decision, for provenance
 * @param options the stability window rules, for recomputing what to park
 * @returns the ADK tool
 */
export function createRecordDecisionTool(
  store: Store,
  model: string,
  options: DriftOptions,
): FunctionTool<typeof parameters> {
  return new FunctionTool({
    name: "record_decision",
    description:
      "Records the verdict for this sweep. Call this exactly once, as the last thing you do.",
    parameters,
    async execute(args): Promise<RecordDecisionResult> {
      return recordDecision(store, model, options, args);
    },
  });
}
