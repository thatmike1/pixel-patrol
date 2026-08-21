/**
 * `get_sweep_context` — the analyst's first call on every run.
 *
 * answers "what am I looking at, and is there anything to compare it to" in one
 * round trip, so the model never has to guess whether a site is on its first
 * sweep.
 */

import { FunctionTool } from "@google/adk";
import { z } from "zod";

import type { DriftOptions } from "../drift.js";
import type { Store } from "../firestore.js";
import { loadComparison, toSweepContext } from "../sweep-context.js";
import type { SweepContext } from "../sweep-context.js";

/** the arguments the model supplies */
const parameters = z.object({
  siteId: z.string().describe("the site under analysis"),
  sweepId: z.string().describe("the sweep that just finished"),
});

/**
 * builds the tool bound to a store.
 *
 * @param store the Firestore accessors
 * @param options the stability window rules, so the reported windowSize matches
 *   the one the diff will use
 * @returns the ADK tool
 */
export function createGetSweepContextTool(
  store: Store,
  options: DriftOptions,
): FunctionTool<typeof parameters> {
  return new FunctionTool({
    name: "get_sweep_context",
    description:
      "Loads the site, this sweep's fingerprint summary, and the approved baseline and previous " +
      "fingerprint summaries if they exist. A null baseline and a null previous mean this is the " +
      "site's first sweep. windowSize is how many earlier sweeps the drift classification can " +
      "reason over, and pendingCount how many findings are already awaiting a human decision.",
    parameters,
    async execute({ siteId, sweepId }): Promise<SweepContext> {
      return toSweepContext(
        await loadComparison(store, siteId, sweepId, options.stabilityWindow),
      );
    },
  });
}
