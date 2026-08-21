/**
 * the drift analysis, as this service performs it: load the sweep's reference
 * point and the site's recent history, then hand both to the pure classifier in
 * `@pixel-patrol/shared`.
 *
 * three callers need exactly this and must agree: the tool the model calls, the
 * tool that records the verdict (which parks the alerting entries in the site's
 * pending sets, and must park precisely what was alerted rather than whatever
 * the model retyped), and the operator's stability report. one function.
 */

import { analyseStability, isIncompatibleResult } from "@pixel-patrol/shared";
import type { StableDiff, StableDiffResult } from "@pixel-patrol/shared";

import type { Store } from "./firestore.js";
import { loadComparison } from "./sweep-context.js";
import type { Comparison } from "./sweep-context.js";

/** the window rules, from the service configuration */
export interface DriftOptions {
  /** N: how many earlier sweeps form the window */
  stabilityWindow: number;
  /** M: consecutive absences before a baseline entry counts as removed */
  goneAfter: number;
}

/** one analysis, with the documents it was computed from */
export interface DriftAnalysis {
  comparison: Comparison;
  result: StableDiffResult;
}

/**
 * classifies one sweep against its baseline and the site's recent history.
 *
 * the site's pending sets are applied so an already-reported finding does not
 * alert again — except when the sweep under analysis is the one that wrote them.
 * that case is a Pub/Sub redelivery of a sweep that already recorded drift, and
 * suppressing its own findings would overwrite that verdict with a noop.
 *
 * @param store the Firestore accessors
 * @param siteId the site under analysis
 * @param sweepId the sweep that just finished
 * @param options the window rules
 * @returns the comparison and its verdict
 * @throws {NotFoundError} when the site or its fingerprint is missing
 */
export async function analyseDrift(
  store: Store,
  siteId: string,
  sweepId: string,
  options: DriftOptions,
): Promise<DriftAnalysis> {
  const comparison = await loadComparison(store, siteId, sweepId, options.stabilityWindow);
  const { site } = comparison;
  const ownFindings = site.pendingSweepId === sweepId;

  const result = analyseStability(
    comparison.current,
    comparison.against,
    comparison.window,
    comparison.comparedTo,
    {
      goneAfter: options.goneAfter,
      pendingDomains: ownFindings ? [] : (site.pendingDomains ?? []),
      pendingCookies: ownFindings ? [] : (site.pendingCookies ?? []),
    },
  );

  return { comparison, result };
}

/** narrows an analysis to the case where a verdict was actually produced */
export function verdictOf(analysis: DriftAnalysis): StableDiff | null {
  return isIncompatibleResult(analysis.result) ? null : analysis.result;
}
