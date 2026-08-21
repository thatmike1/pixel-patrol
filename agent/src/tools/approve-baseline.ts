/**
 * `approve_baseline` — points the site at the snapshot future sweeps are judged
 * against.
 *
 * the agent is only ever meant to call this on a site's first sweep, where there
 * is nothing to compare against and no drift claim would mean anything. once a
 * baseline exists, moving it is a human decision: auto-accepting a drifted state
 * as the new normal is precisely how a tracker gets silently blessed, which is
 * the failure this product is built to catch.
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
interface ApproveBaselineResult {
  ok: true;
  approvedBaselineId: string;
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
      "Sets this sweep as the site's approved baseline. Only use this on a site's very first " +
      "sweep, when there is no baseline and no previous fingerprint.",
    parameters,
    async execute({ siteId, sweepId }): Promise<ApproveBaselineResult> {
      await store.setApprovedBaseline(siteId, sweepId);
      return { ok: true, approvedBaselineId: sweepId };
    },
  });
}
