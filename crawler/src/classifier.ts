/**
 * cookie and tracker classifier — assigns categories to raw scan data
 * using a tiered approach:
 *   1. exact name match in known-cookies DB
 *   2. pattern match in known-cookies DB
 *   3. heuristic regex rules (11 rules covering common naming conventions)
 *   4. fallback to `unclassified`
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
  CookieCategory,
  TrackerCategory,
  ScanSummary,
} from "./types.js";
import { lookupCookie } from "./cookie-db.js";
import { lookupTracker } from "./tracker-db.js";

// ---------------------------------------------------------------------------
// heuristic rules — applied when the DB has no match
// ---------------------------------------------------------------------------

interface HeuristicRule {
  pattern: RegExp;
  category: CookieCategory;
}

/**
 * regex-based heuristic rules for cookie classification.
 * order matters — first match wins. rules are conservative: tracking
 * patterns are caught before generic ones.
 */
const HEURISTIC_RULES: HeuristicRule[] = [
  // analytics patterns
  { pattern: /^_ga/i, category: "analytics" },
  { pattern: /^_gid$/i, category: "analytics" },
  { pattern: /^_gat/i, category: "analytics" },
  { pattern: /^_hj/i, category: "analytics" },
  { pattern: /^_pk_/i, category: "analytics" },
  { pattern: /^mp_/i, category: "analytics" },
  { pattern: /^amplitude/i, category: "analytics" },
  { pattern: /^ajs_/i, category: "analytics" },
  { pattern: /^__utm/i, category: "analytics" },
  { pattern: /^__hstc$/i, category: "analytics" },
  { pattern: /^__hssc$/i, category: "analytics" },
  { pattern: /^hubspotutk$/i, category: "analytics" },
  { pattern: /^collect$/i, category: "analytics" },

  // marketing / advertising patterns
  { pattern: /^_fb/i, category: "marketing" },
  { pattern: /^_gcl_/i, category: "marketing" },
  { pattern: /^_rdt_uuid$/i, category: "marketing" },
  { pattern: /^_tt_/i, category: "marketing" },
  { pattern: /^_ttp$/i, category: "marketing" },
  { pattern: /^_uet/i, category: "marketing" },
  { pattern: /^IDE$/i, category: "marketing" },
  { pattern: /^NID$/i, category: "marketing" },
  { pattern: /^fr$/i, category: "marketing" },
  { pattern: /^test_cookie$/i, category: "marketing" },
  { pattern: /^sklikId$/i, category: "marketing" },
  { pattern: /^_sas_/i, category: "marketing" },

  // functional patterns
  { pattern: /^ssupp/i, category: "functional" },
  { pattern: /^__zlcmid$/i, category: "functional" },
  { pattern: /^intercom-/i, category: "functional" },
  { pattern: /^crisp-/i, category: "functional" },
  { pattern: /^tawk/i, category: "functional" },

  // necessary patterns (session, CSRF, consent)
  { pattern: /^PHPSESSID$/i, category: "necessary" },
  { pattern: /^JSESSIONID$/i, category: "necessary" },
  { pattern: /^csrftoken$/i, category: "necessary" },
  { pattern: /^_csrf$/i, category: "necessary" },
  { pattern: /^XSRF-TOKEN$/i, category: "necessary" },
  { pattern: /^__Host-/i, category: "necessary" },
  { pattern: /^__Secure-/i, category: "necessary" },
  { pattern: /^connect\.sid$/i, category: "necessary" },
  { pattern: /^laravel_session$/i, category: "necessary" },
  { pattern: /^cookieconsent/i, category: "necessary" },
  { pattern: /^CookieConsent$/i, category: "necessary" },
  { pattern: /^OptanonConsent$/i, category: "necessary" },
  { pattern: /^euconsent/i, category: "necessary" },
];

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
  for (const rule of HEURISTIC_RULES) {
    if (rule.pattern.test(raw.name)) {
      return {
        ...raw,
        category: rule.category,
        categorySource: "auto",
        description: null,
      };
    }
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
