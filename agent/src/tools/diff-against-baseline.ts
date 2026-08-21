/**
 * `diff_against_baseline` — the deterministic comparison.
 *
 * the name says baseline because that is the intent; the tool falls back to the
 * previous sweep when no baseline has been approved, and reports which it used
 * in `comparedTo` so the model never has to assume.
 */

import { FunctionTool } from "@google/adk";
import { z } from "zod";

import { diffFingerprints } from "../diff.js";
import type { DiffResult } from "../diff.js";
import type { Store } from "../firestore.js";
import { loadComparison } from "../sweep-context.js";

/** the arguments the model supplies */
const parameters = z.object({
  siteId: z.string().describe("the site under analysis"),
  sweepId: z.string().describe("the sweep that just finished"),
});

/**
 * builds the tool bound to a store.
 *
 * @param store the Firestore accessors
 * @returns the ADK tool
 */
export function createDiffAgainstBaselineTool(store: Store): FunctionTool<typeof parameters> {
  return new FunctionTool({
    name: "diff_against_baseline",
    description:
      "Compares this sweep's fingerprint against the site's approved baseline, or against the " +
      "previous sweep when no baseline is approved. Returns the exact tracking domains and " +
      "cookies that appeared and disappeared. Hosts are compared by registrable domain " +
      "(eTLD+1), so a CDN that rotates its subdomains between sweeps does not read as drift; " +
      "each entry gives the registrableDomain and one example full host. comparedTo is 'none' " +
      "when there is nothing to compare against, in which case all four lists are empty, and " +
      "'incompatible' when the two fingerprints come from different schema generations, in " +
      "which case there are no lists at all and only a reason.",
    parameters,
    async execute({ siteId, sweepId }): Promise<DiffResult> {
      const comparison = await loadComparison(store, siteId, sweepId);
      return diffFingerprints(comparison.current, comparison.against, comparison.comparedTo);
    },
  });
}
