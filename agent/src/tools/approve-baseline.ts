/**
 * `approve_baseline` — points the site at the snapshot future sweeps are judged
 * against.
 *
 * the agent is only ever meant to call this on a site's first sweep, where there
 * is nothing to compare against and no drift claim would mean anything. once a
 * baseline exists, moving it is a human decision: auto-accepting a drifted state
 * as the new normal is precisely how a tracker gets silently blessed, which is
 * the failure this product is built to catch. the operator does it through
 * `POST /sites/:siteId/baseline`.
 *
 * approving also clears the site's pending sets, because approving a baseline IS
 * the decision those entries were waiting for.
 */

import { FunctionTool } from "@google/adk";
import { z } from "zod";

import type { Store } from "../firestore.js";

/** the arguments the model supplies */
const parameters = z.object({
  siteId: z.string().describe("the site under analysis"),
  sweepId: z.string().describe("the sweep to accept as the baseline"),
});

/** what the tool confirms back to the model */
export interface ApproveBaselineResult {
  ok: true;
  approvedBaselineId: string;
  /** the previously reported entries this settles */
  pendingCleared: true;
}

/**
 * points the site at a sweep as its baseline and clears the pending sets.
 *
 * @param store the Firestore accessors
 * @param siteId the site
 * @param sweepId the sweep to accept
 * @returns the confirmation
 */
export async function approveBaseline(
  store: Store,
  siteId: string,
  sweepId: string,
): Promise<ApproveBaselineResult> {
  await store.setApprovedBaseline(siteId, sweepId);
  return { ok: true, approvedBaselineId: sweepId, pendingCleared: true };
}

/**
 * builds the tool bound to a store.
 *
 * @param store the Firestore accessors
 * @returns the ADK tool
 */
export function createApproveBaselineTool(store: Store): FunctionTool<typeof parameters> {
  return new FunctionTool({
    name: "approve_baseline",
    description:
      "Sets this sweep as the site's approved baseline and clears anything previously reported " +
      "and awaiting approval. Only use this on a site's very first sweep, when there is no " +
      "baseline and no previous fingerprint, or when a diff came back 'incompatible'.",
    parameters,
    async execute({ siteId, sweepId }): Promise<ApproveBaselineResult> {
      return approveBaseline(store, siteId, sweepId);
    },
  });
}
