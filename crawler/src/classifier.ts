/**
 * cookie and tracker classifier — assigns categories to raw scan data
 * using a tiered approach:
 *   1. exact name match in known-cookies DB
 *   2. pattern match in known-cookies DB
 *   3. heuristic regex rules covering common naming conventions
 *   4. fallback to `unclassified`
 *
 * the tables and the regex rules themselves live in `@pixel-patrol/shared`,
 * because the agent grounds its classification of a newly appeared host in the
 * same tiers. this file is the part only the scanner needs: applying them to
 * raw scan rows and scoring the result.
 *
 * design principle: err toward over-restricting. if we're unsure, classify
 * as marketing/analytics rather than necessary. a false positive (blocking
 * a necessary cookie) is less legally risky than a false negative (allowing
 * a tracking cookie to fire without consent).
 */

import type {
  RawCookie,
  ClassifiedCookie,
  RawTracker,
  ClassifiedTracker,
  ScanSummary,
} from "./types.js";
import { heuristicCookieCategory, lookupCookie, lookupTracker } from "@pixel-patrol/shared";

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * classifies a raw cookie through the tiered pipeline:
 * exact name → pattern match → heuristic regex → unclassified.
 */
export function classifyCookie(raw: RawCookie): ClassifiedCookie {
  // tier 1 + 2: known cookie database (exact + pattern)
  const known = lookupCookie(raw.name);
  if (known) {
    return {
      ...raw,
      category: known.category,
      categorySource: "auto",
      description: known.description_cs,
    };
  }

  // tier 3: heuristic regex rules
  const heuristic = heuristicCookieCategory(raw.name);
  if (heuristic) {
    return {
      ...raw,
      category: heuristic,
      categorySource: "auto",
      description: null,
    };
  }

  // tier 4: fallback
  return {
    ...raw,
    category: "unclassified",
    categorySource: "auto",
    description: null,
  };
}

/**
 * classifies a raw tracker via the known-trackers database.
 * NEVER assigns `necessary` — trackers are never necessary by definition,
 * and the DB CHECK constraint for detected_trackers.category does not
 * include `necessary`.
 */
export function classifyTracker(raw: RawTracker): ClassifiedTracker {
  const known = lookupTracker(raw.domain);
  if (known) {
    return {
      ...raw,
      vendorName: known.vendor,
      category: known.category,
    };
  }

  return {
    ...raw,
    vendorName: null,
    category: "unclassified",
  };
}

/**
 * calculates a scanner-observable compliance score (0-100).
 *
 * this is the scanner's contribution only — the frontend augments it with
 * policy/banner/ropa factors later. formula:
 *
 * - pre-consent non-necessary cookies: -5 per cookie, max -50
 *   (heaviest weight — Art. 6 / ePrivacy violation)
 * - unclassified cookies: up to -40 proportional
 *   (user action needed to resolve)
 * - missing descriptions: up to -20 proportional
 *   (transparency gap, lower severity)
 */
export function calculateComplianceScore(
  cookies: ClassifiedCookie[],
  _trackers: ClassifiedTracker[],
  summary: ScanSummary,
): number {
  const totalCookies = cookies.length;
  let score = 100;

  if (totalCookies > 0) {
    const unclassifiedPct = summary.unclassifiedCount / totalCookies;
    const noDescriptionCount = cookies.filter((c) => !c.description).length;
    const noDescriptionPct = noDescriptionCount / totalCookies;

    score -= Math.round(unclassifiedPct * 40);
    score -= Math.min(summary.preConsentNonNecessaryCount, 10) * 5;
    score -= Math.round(noDescriptionPct * 20);
  }

  return Math.max(0, Math.min(100, score));
}
