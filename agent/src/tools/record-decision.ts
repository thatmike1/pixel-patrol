/**
 * `record_decision` — the only durable output of a run.
 *
 * the analyst's prose answer is logged and then thrown away; this document is
 * what the dashboard, the ticket and the owner email will read. the instruction
 * requires exactly one call, so the tool reports back what it wrote and the
 * model has nothing left to do afterwards.
 */

import { FunctionTool } from "@google/adk";
import { z } from "zod";

import type { Store } from "../firestore.js";
import type { Decision } from "../types.js";

/** the arguments the model supplies */
const parameters = z.object({
  siteId: z.string().describe("the site under analysis"),
  sweepId: z.string().describe("the sweep that just finished"),
  action: z
    .enum(["noop", "drift", "baseline-created"])
    .describe(
      "noop when nothing changed, drift when hosts or cookies were added or removed, " +
        "baseline-created when this sweep became the site's first approved baseline",
    ),
  summary: z.string().describe("one sentence a non-technical site owner would understand"),
  hostsAdded: z
    .array(z.string())
    .optional()
    .describe("registrableDomain values that appeared, from the diff; omit when none"),
  hostsRemoved: z
    .array(z.string())
    .optional()
    .describe("registrableDomain values that disappeared, from the diff; omit when none"),
});

/** what the tool confirms back to the model */
interface RecordDecisionResult {
  ok: true;
  path: string;
}

/**
 * builds the tool bound to a store.
 *
 * @param store the Firestore accessors
 * @param model the model id stamped on the decision, for provenance
 * @returns the ADK tool
 */
export function createRecordDecisionTool(
  store: Store,
  model: string,
): FunctionTool<typeof parameters> {
  return new FunctionTool({
    name: "record_decision",
    description:
      "Records the verdict for this sweep. Call this exactly once, as the last thing you do.",
    parameters,
    async execute(args): Promise<RecordDecisionResult> {
      const decision: Decision = {
        siteId: args.siteId,
        sweepId: args.sweepId,
        action: args.action,
        summary: args.summary,
        ...(args.hostsAdded?.length ? { hostsAdded: args.hostsAdded } : {}),
        ...(args.hostsRemoved?.length ? { hostsRemoved: args.hostsRemoved } : {}),
        at: new Date().toISOString(),
        model,
      };

      await store.writeDecision(decision);
      return { ok: true, path: `sites/${args.siteId}/decisions/${args.sweepId}` };
    },
  });
}
