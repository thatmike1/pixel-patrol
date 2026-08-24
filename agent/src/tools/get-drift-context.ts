/**
 * `get_drift_context` — everything the scribe is allowed to write from, in one
 * call.
 *
 * the scribe never sees the site, the sweep or the internet: it sees the
 * decision the analyst recorded, the alerting half of the diff behind it, and
 * the vendor table entries for the domains and cookies involved. that is
 * deliberate. a redline is a document a site owner will paste into their public
 * cookie policy, so the set of facts it can contain has to be a set someone can
 * check, and this tool is that set.
 */

import { FunctionTool } from "@google/adk";
import { lookupCookieKnowledge, lookupHostKnowledge } from "@pixel-patrol/shared";
import type { CookieKnowledge, DriftAlerts, HostKnowledge } from "@pixel-patrol/shared";
import { z } from "zod";

import { analyseDrift, verdictOf } from "../drift.js";
import type { DriftOptions } from "../drift.js";
import type { Store } from "../firestore.js";
import type { Decision } from "../types.js";

/** the arguments the model supplies */
const parameters = z.object({
  siteId: z.string().describe("the site the drift was found on"),
  sweepId: z.string().describe("the sweep that produced the drift decision"),
});

/** the site details a policy has to name */
export interface DriftSite {
  siteId: string;
  url: string;
  ownerEmail?: string;
}

/** what the scribe reads */
export interface DriftContext {
  site: DriftSite;
  decision: Decision;
  /** the alerting half of the diff; noise is not the scribe's business */
  alerts: DriftAlerts | null;
  /** the vendor table entries for each added domain, one per hostsAdded entry */
  hosts: HostKnowledge[];
  /** the cookie table entries for each added cookie name */
  cookies: CookieKnowledge[];
}

/** raised when the scribe is pointed at a sweep with no decision behind it */
export class NoDecisionError extends Error {
  constructor(siteId: string, sweepId: string) {
    super(`no decision at sites/${siteId}/decisions/${sweepId}`);
    this.name = "NoDecisionError";
  }
}

/**
 * loads the decision, its diff and the vendor knowledge behind it.
 *
 * the diff is recomputed rather than read off the decision: the decision
 * carries the domains the model reported, and the policy has to be written
 * about what the scanner actually saw, including the example hosts and cookie
 * durations the decision does not store.
 *
 * @param store the Firestore accessors
 * @param options the stability window rules, so the alerts match the analyst's
 * @param args the site and sweep
 * @returns the facts the redline may be built from
 * @throws {NoDecisionError} when no decision was recorded for that sweep
 */
export async function driftContext(
  store: Store,
  options: DriftOptions,
  args: z.infer<typeof parameters>,
): Promise<DriftContext> {
  const { siteId, sweepId } = args;

  const decision = await store.getDecision(siteId, sweepId);
  if (!decision) throw new NoDecisionError(siteId, sweepId);

  const analysis = await analyseDrift(store, siteId, sweepId, options);
  const verdict = verdictOf(analysis);
  const alerts = verdict?.alerts ?? null;
  const site = analysis.comparison.site;

  // the recomputed alerts are the first source; the decision's own host list is
  // the fallback, because a redelivery that re-parked the findings would leave
  // the alerts empty while the decision it is documenting still stands
  const added =
    alerts && alerts.hostsAdded.length > 0
      ? alerts.hostsAdded.map((entry) => ({
          domain: entry.registrableDomain,
          example: entry.host,
        }))
      : (decision.hostsAdded ?? []).map((domain) => ({ domain, example: domain }));

  const cookieNames =
    alerts && alerts.cookiesAdded.length > 0
      ? alerts.cookiesAdded.map((entry) => entry.name)
      : [];

  return {
    site: {
      siteId: site.siteId,
      url: site.url,
      ...(site.ownerEmail ? { ownerEmail: site.ownerEmail } : {}),
    },
    decision,
    alerts,
    hosts: added.map((entry) => lookupHostKnowledge(entry.domain, entry.example)),
    cookies: cookieNames.map(lookupCookieKnowledge),
  };
}

/**
 * builds the tool bound to a store.
 *
 * @param store the Firestore accessors
 * @param options the stability window rules
 * @returns the ADK tool
 */
export function createGetDriftContextTool(
  store: Store,
  options: DriftOptions,
): FunctionTool<typeof parameters> {
  return new FunctionTool({
    name: "get_drift_context",
    description:
      "Loads the drift decision to document: the site, the analyst's verdict and its " +
      "classifications, the tracking domains and cookies that appeared, and what the vendor " +
      "tables know about each of them. `hosts[].exact` is a table entry and null when the " +
      "domain is unknown; `cookies[].exact` carries the Czech purpose text and typical " +
      "duration in seconds. This is the only source of facts you have.",
    parameters,
    async execute(args): Promise<DriftContext> {
      return driftContext(store, options, args);
    },
  });
}
