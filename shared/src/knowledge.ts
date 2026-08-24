/**
 * what is known about a host or a cookie, and how confident that knowledge is.
 *
 * the crawler has always classified through a tiered pipeline: the vendor
 * tables first, regex heuristics second, `unclassified` last. the agent needs
 * exactly the same tiers for a different job — it has one domain that appeared
 * on a site overnight and has to say who runs it and what it is for, in a
 * document a regulator may read. so the tiers live here, and both callers get
 * the same answer.
 *
 * the point of this module is grounding, not cleverness. it returns what the
 * tables actually contain, including nothing, and it never guesses a vendor. a
 * model handed "no entry, no near match, heuristic says nothing" is supposed to
 * answer `unclassified`, and it can only do that honestly if this file resists
 * the temptation to fill the gap for it.
 */

import type { CookieCategory, TrackerCategory } from "./fingerprint.js";
import { allCookies, lookupCookie } from "./cookie-db.js";
import type { KnownCookie } from "./cookie-db.js";
import { allTrackers, lookupTracker } from "./tracker-db.js";
import type { KnownTracker } from "./tracker-db.js";

// ---------------------------------------------------------------------------
// heuristics
// ---------------------------------------------------------------------------

/** one regex rule and the category a match implies */
interface HeuristicRule<T> {
  pattern: RegExp;
  category: T;
}

/**
 * cookie name heuristics, applied when the table has no match. order matters —
 * first match wins, and tracking patterns are listed before generic ones.
 *
 * conservative in one direction on purpose: an unsure cookie is called
 * marketing or analytics rather than necessary, because blocking a necessary
 * cookie is a smaller legal problem than letting a tracking one fire without
 * consent.
 */
const COOKIE_RULES: HeuristicRule<CookieCategory>[] = [
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

/**
 * hostname heuristics for a domain the table has never seen.
 *
 * deliberately thin. these read intent off naming conventions the ad-tech
 * industry uses for its own convenience ("pixel.", "-ads.", "analytics."), and
 * that is all they are worth: a hint the model is told to label as a hint. a
 * host that matches nothing here is genuinely unknown, and saying so is the
 * correct outcome.
 */
const HOST_RULES: HeuristicRule<TrackerCategory>[] = [
  { pattern: /(^|[.\-_])(pixel|px|beacon|track(er|ing)?|collect|telemetry)([.\-_]|$)/i, category: "analytics" },
  { pattern: /(^|[.\-_])(analytics|stats?|metrics|measure|insights?)([.\-_]|$)/i, category: "analytics" },
  { pattern: /(^|[.\-_])(ads?|adserver|adtech|adsrvr|dsp|rtb|bid(der|ding)?|retarget\w*|affil\w*)([.\-_]|$)/i, category: "marketing" },
  { pattern: /(^|[.\-_])(tag|tags|tagmanager|gtm|consent|cmp)([.\-_]|$)/i, category: "functional" },
];

/**
 * the heuristic category for a cookie name, or null when no rule matches.
 *
 * @param name the cookie name as observed
 * @returns the implied category, or null
 */
export function heuristicCookieCategory(name: string): CookieCategory | null {
  for (const rule of COOKIE_RULES) {
    if (rule.pattern.test(name)) return rule.category;
  }
  return null;
}

/**
 * the heuristic category for a hostname, with the rule that produced it.
 *
 * the matched pattern is returned as text because it is the evidence: a
 * classification whose only support is a regex has to be able to say which
 * regex, or it is indistinguishable from a guess.
 *
 * @param host the hostname or registrable domain to read
 * @returns the implied category and the rule source, or nulls when nothing matched
 */
export function heuristicHostCategory(host: string): {
  category: TrackerCategory | null;
  matchedRule: string | null;
} {
  for (const rule of HOST_RULES) {
    if (rule.pattern.test(host)) {
      return { category: rule.category, matchedRule: rule.pattern.source };
    }
  }
  return { category: null, matchedRule: null };
}

// ---------------------------------------------------------------------------
// grounding
// ---------------------------------------------------------------------------

/** a table entry judged similar to the domain under question, and why */
export interface RelatedTracker extends KnownTracker {
  /** the token both the queried domain and this entry share */
  sharedToken: string;
}

/** a cookie table entry attributed to a vendor the queried domain resembles */
export interface RelatedCookie extends KnownCookie {
  sharedToken: string;
}

/** everything the tables and the heuristics can say about one host */
export interface HostKnowledge {
  registrableDomain: string;
  exampleHost: string;
  /** the table entry for this domain, or for a parent of the example host */
  exact: KnownTracker | null;
  /** entries sharing a brand token with it — a sibling domain of the same vendor */
  related: RelatedTracker[];
  /** cookies the table attributes to a vendor whose name shares that token */
  relatedCookies: RelatedCookie[];
  /** what the naming convention suggests, when the tables know nothing */
  heuristic: { category: TrackerCategory | null; matchedRule: string | null };
  /** the closed set of categories the tables use, so a classification lands in it */
  categories: TrackerCategory[];
}

/** the token searched for, when the domain yields one worth searching on */
const MIN_TOKEN_LENGTH = 4;

/**
 * the brand token of a registrable domain: its label without the public suffix.
 *
 * `jhmt.cz` gives `jhmt`, `doubleclick.net` gives `doubleclick`. short tokens
 * are dropped — a three-letter token matches half the table and would hand the
 * model a page of unrelated vendors as if they were evidence.
 *
 * @param registrableDomain the eTLD+1 under question
 * @returns the token, or null when there is none worth matching on
 */
export function brandToken(registrableDomain: string): string | null {
  const label = registrableDomain.toLowerCase().split(".")[0] ?? "";
  const cleaned = label.replace(/[^a-z0-9]/g, "");
  return cleaned.length >= MIN_TOKEN_LENGTH ? cleaned : null;
}

/** how many near matches are worth showing before the list stops being evidence */
const MAX_RELATED = 8;

/**
 * gathers everything known about a host, without touching the network.
 *
 * the three tiers are returned side by side rather than collapsed into one
 * verdict on purpose. collapsing them would hide which tier answered, and the
 * difference between "the vendor table names this domain" and "it merely looks
 * like an ad server" is the whole difference between a classification someone
 * can defend and one they cannot.
 *
 * @param registrableDomain the eTLD+1 the diff reported as added
 * @param exampleHost one full hostname observed under it
 * @returns the table entries, the near matches, the heuristic verdict and the taxonomy
 */
export function lookupHostKnowledge(
  registrableDomain: string,
  exampleHost: string,
): HostKnowledge {
  const domain = registrableDomain.toLowerCase();
  const host = (exampleHost || registrableDomain).toLowerCase();

  // the example host first: the table often names a specific subdomain
  // (`ssl.google-analytics.com`) that the registrable domain alone would miss
  const exact = lookupTracker(host) ?? lookupTracker(domain);

  const token = brandToken(domain);
  const related: RelatedTracker[] = [];
  const relatedCookies: RelatedCookie[] = [];

  if (token) {
    for (const entry of allTrackers()) {
      if (entry.domain.toLowerCase() === domain) continue;
      if (matchesToken(entry.domain, entry.vendor, token)) {
        related.push({ ...entry, sharedToken: token });
        if (related.length >= MAX_RELATED) break;
      }
    }
    for (const entry of allCookies()) {
      if (matchesToken(entry.name, entry.vendor, token)) {
        relatedCookies.push({ ...entry, sharedToken: token });
        if (relatedCookies.length >= MAX_RELATED) break;
      }
    }
  }

  return {
    registrableDomain: domain,
    exampleHost: host,
    exact,
    related,
    relatedCookies,
    heuristic: heuristicHostCategory(host),
    categories: trackerCategories(),
  };
}

/** what the cookie tables know about one observed cookie name */
export interface CookieKnowledge {
  name: string;
  exact: KnownCookie | null;
  heuristic: CookieCategory | null;
}

/**
 * the table entry and heuristic verdict for one cookie name.
 *
 * @param name the cookie name as observed
 * @returns the entry, or nulls when the name is unknown
 */
export function lookupCookieKnowledge(name: string): CookieKnowledge {
  return {
    name,
    exact: lookupCookie(name),
    heuristic: heuristicCookieCategory(name),
  };
}

/**
 * the distinct categories present in the tracker table.
 *
 * the model classifies onto this set rather than onto whatever noun it would
 * otherwise reach for, so a consent banner built from these decisions has the
 * same buckets the scanner does.
 *
 * @returns the categories, sorted, always including `unclassified`
 */
export function trackerCategories(): TrackerCategory[] {
  const present = new Set<TrackerCategory>(allTrackers().map((entry) => entry.category));
  present.add("unclassified");
  return [...present].sort();
}

/**
 * whether a table entry shares the queried brand token.
 *
 * both directions are checked, because a vendor's second domain is named either
 * way round: `jhmt.cz` should find a `jhmt-analytics.com` entry (the entry
 * contains the token), and a queried `hotjar-cdn.io` should find plain
 * `hotjar.com` (the token contains the entry's own token). the containing side
 * is held to the same minimum length, so a short fragment cannot drag in
 * everything it happens to appear inside.
 */
function matchesToken(name: string, vendor: string, token: string): boolean {
  const haystack = `${name} ${vendor}`.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (haystack.includes(token)) return true;

  return words(`${name} ${vendor}`).some(
    (word) => word.length >= MIN_TOKEN_LENGTH && token.includes(word),
  );
}

/** the alphanumeric words of a label, split on separators and case boundaries */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0);
}
