/**
 * `diff_against_baseline` — the deterministic comparison, split into what is
 * worth an alert and what the site's own recent history explains away.
 *
 * the name says baseline because that is the intent; the tool falls back to the
 * previous sweep when no baseline has been approved, and reports which it used
 * in `comparedTo` so the model never has to assume.
 */

import { FunctionTool } from "@google/adk";
import { z } from "zod";

import { analyseDrift } from "../drift.js";
import type { DriftOptions } from "../drift.js";
import type { Store } from "../firestore.js";
import type { StableDiffResult } from "@pixel-patrol/shared";

/** the arguments the model supplies */
const parameters = z.object({
  siteId: z.string().describe("the site under analysis"),
  sweepId: z.string().describe("the sweep that just finished"),
});

/**
 * builds the tool bound to a store.
 *
 * @param store the Firestore accessors
 * @param options the stability window rules
 * @returns the ADK tool
 */
export function createDiffAgainstBaselineTool(
  store: Store,
  options: DriftOptions,
): FunctionTool<typeof parameters> {
  return new FunctionTool({
    name: "diff_against_baseline",
    description:
      "Compares this sweep's fingerprint against the site's approved baseline, or against the " +
      "previous sweep when no baseline is approved, and classifies every difference against the " +
      "site's last few sweeps. `alerts` holds the differences a person must act on: a tracking " +
      "domain or cookie that is genuinely new (never seen in the window), one that has been " +
      "present in every recent sweep without ever being approved, or one from the baseline that " +
      "has now been absent several sweeps running. `noise` holds differences that are not " +
      "alerts: `flapping` is ad-tech and A/B rotation that comes and goes by itself, " +
      "`missingOnce` is a baseline entry absent from this sweep alone, and `pending` was already " +
      "reported and is waiting for a human to approve or reject it. Every entry carries its " +
      "presenceRatio, the fraction of the last windowSize sweeps that contained it. Hosts are " +
      "compared by registrable domain (eTLD+1), so a CDN rotating its subdomains is invisible " +
      "here; each entry gives the registrableDomain and one example full host. comparedTo is " +
      "'none' when there is nothing to compare against, and 'incompatible' when the two " +
      "fingerprints come from different schema generations, in which case there are no lists at " +
      "all and only a reason.",
    parameters,
    async execute({ siteId, sweepId }): Promise<StableDiffResult> {
      return (await analyseDrift(store, siteId, sweepId, options)).result;
    },
  });
}
