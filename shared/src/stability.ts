/**
 * the stability window — the layer that decides which set differences are worth
 * waking a human for.
 *
 * keying hosts on the registrable domain killed CDN shard churn, but on a real
 * commercial site the *domain set itself* still moves between sweeps: a
 * programmatic ad slot fills with a different vendor on every pageview, A/B
 * tools load for a fraction of visits, consent-mode variants come and go. a
 * compliance agent that alerts on that gets muted within a week, and a muted
 * watchdog is worse than none — it produces the paperwork of vigilance without
 * the vigilance.
 *
 * so a set difference is not the alert. the alert is a difference the site's own
 * recent history cannot explain as rotation:
 *
 *   presenceRatio  fraction of the last N sweeps (before this one) that
 *                  contained the domain or cookie
 *
 *   new            in this sweep, not in the baseline, presenceRatio 0 — never
 *                  seen before at all. THIS is a tracker that appeared.
 *   returning      in this sweep, not in the baseline, presenceRatio 1 — in
 *                  every recent sweep, so a persistent addition nobody
 *                  approved, not rotation.
 *   flapping       in and out across the window. ad rotation. reported, never alerted.
 *   gone           in the baseline, absent from this sweep and from the last M —
 *                  a genuine removal.
 *   missing-once   in the baseline, absent now, but present within the last M.
 *                  one bad pageview, not a removal.
 *   stable         in both the baseline and this sweep. the site as approved.
 *   pending        would have alerted, but was already reported and is waiting
 *                  for someone to approve or reject it. reported once, not hourly.
 *
 * every classification is computed here, from documents, deterministically. the
 * model is told which bucket each entry landed in and is forbidden from moving
 * anything between them.
 */

import type { CookieDelta, DiffBasis, HostDelta, IncompatibleDiff } from "./diff.js";
import {
  cookieKey,
  groupByRegistrableDomain,
  hostKey,
  INCOMPATIBLE_REASON,
  isComparable,
} from "./diff.js";
import type { Fingerprint, FingerprintCookie } from "./fingerprint.js";

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

/** N: how many sweeps before the current one form the stability window */
export const DEFAULT_STABILITY_WINDOW = 5;

/**
 * M: how many consecutive recent sweeps a baseline entry must be missing from
 * before its disappearance is called a removal rather than a bad pageview.
 */
export const DEFAULT_GONE_AFTER = 3;

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

/** where one domain or cookie landed against the site's recent history */
export type StabilityClass =
  | "stable"
  | "new"
  | "returning"
  | "flapping"
  | "gone"
  | "missing-once"
  | "pending";

/** the classes that are worth a human's attention */
const ALERTING: ReadonlySet<StabilityClass> = new Set<StabilityClass>(["new", "returning", "gone"]);

/** how an entry sits against the window, carried on every reported entry */
export interface StabilityFacts {
  /** fraction of the window's fingerprints that contained it; 0 when the window is empty */
  presenceRatio: number;
  inBaseline: boolean;
  inCurrent: boolean;
  classification: StabilityClass;
}

/** a registrable domain, with its verdict */
export type HostEntry = HostDelta & StabilityFacts;

/** a cookie, with its verdict */
export type CookieEntry = CookieDelta & StabilityFacts;

/** a reported-but-not-alerting entry, tagged so one list can hold both kinds */
export type NoiseEntry = ({ kind: "host" } & HostEntry) | ({ kind: "cookie" } & CookieEntry);

/** the differences a person should act on */
export interface DriftAlerts {
  hostsAdded: HostEntry[];
  hostsRemoved: HostEntry[];
  cookiesAdded: CookieEntry[];
  cookiesRemoved: CookieEntry[];
}

/** the differences the window explains away */
export interface DriftNoise {
  /** rotates in and out of the site by itself — ad tech, A/B tools, consent variants */
  flapping: NoiseEntry[];
  /** in the baseline, absent from this sweep only */
  missingOnce: NoiseEntry[];
  /** already reported as drift, waiting on a baseline decision */
  pending: NoiseEntry[];
}

/** the full verdict for one sweep */
export interface StableDiff {
  comparedTo: DiffBasis;
  /** how many earlier fingerprints the ratios were computed over */
  windowSize: number;
  alerts: DriftAlerts;
  noise: DriftNoise;
  /** total entries across the three noise lists, for the summary line */
  noiseCount: number;
  hashChanged: boolean;
}

/** what the drift analysis hands back */
export type StableDiffResult = StableDiff | IncompatibleDiff;

/** narrows a result to the refusal case */
export function isIncompatibleResult(result: StableDiffResult): result is IncompatibleDiff {
  return result.comparedTo === "incompatible";
}

/** the knobs, all with defaults */
export interface StabilityOptions {
  /** M — see {@link DEFAULT_GONE_AFTER} */
  goneAfter?: number;
  /** registrable domains already reported and awaiting a baseline decision */
  pendingDomains?: readonly string[];
  /** cookie keys (`domain name`) already reported and awaiting a baseline decision */
  pendingCookies?: readonly string[];
}

/** every entry with its verdict, before the alert/noise split */
export interface StabilityTable {
  comparedTo: DiffBasis;
  windowSize: number;
  hosts: HostEntry[];
  cookies: CookieEntry[];
  hashChanged: boolean;
}

// ---------------------------------------------------------------------------
// randomized cookie names
// ---------------------------------------------------------------------------

/** a uuid anywhere in the name */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * whether a cookie name looks generated rather than chosen.
 *
 * an identifier baked into the cookie NAME can never match between two sweeps,
 * so it would alert as a new cookie forever. the test is deliberately narrow —
 * a uuid, or a segment of 8+ characters that is entirely hex and contains a
 * digit — because the cost of a false positive here is a real tracking cookie
 * written off as noise. `_ga_G7X8L2K9QP` is not hex, and stays alertable.
 *
 * @param name the cookie name
 * @returns true when the name cannot be expected to repeat
 */
export function isRandomizedCookieName(name: string): boolean {
  if (UUID.test(name)) return true;
  return name
    .split(/[^A-Za-z0-9]+/)
    .some((segment) => segment.length >= 8 && /^[0-9a-f]+$/i.test(segment) && /\d/.test(segment));
}

/**
 * the part of a name before its trailing digits, or null when it has none.
 *
 * `sp_track_18` and `sp_track_42` share the stem `sp_track`, which is how a
 * counter-suffixed cookie family is recognised without hardcoding vendors.
 */
function numericStem(name: string): string | null {
  const match = /^(.*?)(\d{2,})$/.exec(name);
  const stem = match?.[1]?.replace(/[-_.]+$/, "");
  return stem ? stem : null;
}

/**
 * cookie keys whose name differs from a sibling's only in its trailing digits.
 *
 * @param cookies every cookie seen across the current sweep, the baseline and the window
 * @returns the keys that belong to a numeric-suffix family
 */
export function volatileNumericKeys(
  cookies: Iterable<Pick<FingerprintCookie, "name" | "domain">>,
): Set<string> {
  const families = new Map<string, Map<string, string>>();
  for (const cookie of cookies) {
    const stem = numericStem(cookie.name);
    if (!stem) continue;
    const familyKey = `${cookie.domain} ${stem}`;
    const family = families.get(familyKey) ?? new Map<string, string>();
    family.set(cookie.name, cookieKey(cookie));
    families.set(familyKey, family);
  }

  const volatile = new Set<string>();
  for (const family of families.values()) {
    if (family.size < 2) continue;
    for (const key of family.values()) volatile.add(key);
  }
  return volatile;
}

// ---------------------------------------------------------------------------
// the window
// ---------------------------------------------------------------------------

/** one earlier sweep reduced to the two key sets the window needs */
interface WindowSlice {
  domains: Set<string>;
  cookies: Set<string>;
}

/**
 * prepares the window: same schema generation as the current sweep, newest
 * first, with the current sweep and the reference snapshot both removed.
 *
 * a fingerprint from another generation carries no comparable keys, so counting
 * it would drag every ratio down and turn stable domains into flapping ones.
 *
 * the reference is excluded for a subtler reason: it is already the "before"
 * side of the comparison, and counting it again as history double-counts it. a
 * domain added right after a baseline was approved is absent from that baseline
 * by definition, so leaving it in the window would hold the ratio below 1 for
 * the next N sweeps and file a persistent unapproved addition as rotation.
 *
 * @param current the sweep under analysis
 * @param window candidate earlier fingerprints, in any order
 * @param against the snapshot the sweep is being measured against, if any
 * @returns the usable ones, newest first
 */
export function prepareWindow(
  current: Fingerprint,
  window: readonly Fingerprint[],
  against?: Fingerprint | null,
): Fingerprint[] {
  return window
    .filter(
      (fp) =>
        fp.sweepId !== current.sweepId &&
        fp.sweepId !== against?.sweepId &&
        fp.schemaVersion === current.schemaVersion,
    )
    .slice()
    .sort((a, b) => (a.scannedAt < b.scannedAt ? 1 : a.scannedAt > b.scannedAt ? -1 : 0));
}

/** reduces a fingerprint to its domain and cookie key sets */
function toSlice(fp: Fingerprint): WindowSlice {
  return {
    domains: new Set(fp.hosts.map(hostKey)),
    cookies: new Set(fp.cookies.map(cookieKey)),
  };
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

/** the per-key evidence a classification is made from */
export interface Evidence {
  inCurrent: boolean;
  inBaseline: boolean;
  presenceRatio: number;
  /** absent from every one of the last min(M, windowSize) sweeps */
  absentFromRecent: boolean;
  /** already reported, waiting on a baseline decision */
  isPending: boolean;
  /** the name cannot be expected to repeat, so an alert would never clear */
  isRandomized: boolean;
}

/**
 * the verdict for one domain or cookie.
 *
 * an empty window makes presenceRatio 0 and `absentFromRecent` vacuously true:
 * with no history to appeal to, an addition is new and a disappearance is a
 * removal. that is the right default — it is what a first comparison against a
 * fresh baseline should say, and it is what makes the demo's Meta Pixel alert
 * on first sight.
 *
 * @param evidence the counts for this key
 * @returns which bucket it belongs in
 */
export function classify(evidence: Evidence): StabilityClass {
  const { inCurrent, inBaseline, presenceRatio, absentFromRecent, isPending, isRandomized } =
    evidence;

  if (inBaseline && inCurrent) return "stable";

  let verdict: StabilityClass;
  if (inCurrent) {
    // not in the baseline: an addition, unless the site adds and drops it by itself
    if (presenceRatio === 0) verdict = "new";
    else if (presenceRatio === 1) verdict = "returning";
    else verdict = "flapping";
  } else if (inBaseline) {
    verdict = absentFromRecent ? "gone" : "missing-once";
  } else {
    // seen only inside the window: it belongs neither to the approved state nor
    // to this sweep, so it is the site rotating something in and out on its own
    return "flapping";
  }

  if (!ALERTING.has(verdict)) return verdict;
  // a name that cannot repeat would alert on every sweep, forever
  if (isRandomized) return "flapping";
  return isPending ? "pending" : verdict;
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

/**
 * classifies every domain and cookie in (current union baseline union window).
 *
 * this is the whole computation; `analyseStability` is this plus the split into
 * alerts and noise, and the report tool reads the table directly because a human
 * tuning the thresholds wants to see the stable entries too.
 *
 * @param current the fingerprint produced by the sweep under analysis
 * @param against the approved baseline, or the previous sweep when none is approved
 * @param window up to N fingerprints scanned before this one
 * @param comparedTo which of the two `against` is
 * @param options the window rules and the pending sets
 * @returns every entry with its verdict
 */
export function stabilityTable(
  current: Fingerprint,
  against: Fingerprint,
  window: readonly Fingerprint[],
  comparedTo: DiffBasis,
  options: StabilityOptions = {},
): StabilityTable {
  const goneAfter = options.goneAfter ?? DEFAULT_GONE_AFTER;
  const pendingDomains = new Set(options.pendingDomains ?? []);
  const pendingCookies = new Set(options.pendingCookies ?? []);

  const windowFingerprints = prepareWindow(current, window, against);
  const slices = windowFingerprints.map(toSlice);
  const windowSize = slices.length;
  const recent = slices.slice(0, Math.min(goneAfter, windowSize));

  // ---- hosts ---------------------------------------------------------------

  const currentHosts = groupByRegistrableDomain(current.hosts);
  const baselineHosts = groupByRegistrableDomain(against.hosts);
  // display metadata falls back through the window, oldest first so a more
  // recent sighting (and any vendor attribution it carried) wins
  const hostMeta = new Map<string, HostDelta>();
  for (const fp of [...windowFingerprints].reverse()) {
    for (const [key, delta] of groupByRegistrableDomain(fp.hosts)) hostMeta.set(key, delta);
  }
  for (const [key, delta] of baselineHosts) hostMeta.set(key, delta);
  for (const [key, delta] of currentHosts) hostMeta.set(key, delta);

  const hosts: HostEntry[] = [];
  for (const key of [...hostMeta.keys()].sort()) {
    const inCurrent = currentHosts.has(key);
    const inBaseline = baselineHosts.has(key);
    const seen = slices.filter((s) => s.domains.has(key)).length;
    const presenceRatio = windowSize === 0 ? 0 : seen / windowSize;
    const classification = classify({
      inCurrent,
      inBaseline,
      presenceRatio,
      absentFromRecent: recent.every((s) => !s.domains.has(key)),
      isPending: pendingDomains.has(key),
      isRandomized: false,
    });
    hosts.push({
      ...(hostMeta.get(key) as HostDelta),
      presenceRatio,
      inBaseline,
      inCurrent,
      classification,
    });
  }

  // ---- cookies -------------------------------------------------------------

  const currentCookies = new Map(current.cookies.map((c) => [cookieKey(c), c] as const));
  const baselineCookies = new Map(against.cookies.map((c) => [cookieKey(c), c] as const));
  const cookieMeta = new Map<string, FingerprintCookie>();
  for (const fp of [...windowFingerprints].reverse()) {
    for (const cookie of fp.cookies) cookieMeta.set(cookieKey(cookie), cookie);
  }
  for (const [key, cookie] of baselineCookies) cookieMeta.set(key, cookie);
  for (const [key, cookie] of currentCookies) cookieMeta.set(key, cookie);

  const volatile = volatileNumericKeys(cookieMeta.values());

  const cookies: CookieEntry[] = [];
  for (const key of [...cookieMeta.keys()].sort()) {
    const cookie = cookieMeta.get(key) as FingerprintCookie;
    const inCurrent = currentCookies.has(key);
    const inBaseline = baselineCookies.has(key);
    const seen = slices.filter((s) => s.cookies.has(key)).length;
    const presenceRatio = windowSize === 0 ? 0 : seen / windowSize;
    const classification = classify({
      inCurrent,
      inBaseline,
      presenceRatio,
      absentFromRecent: recent.every((s) => !s.cookies.has(key)),
      isPending: pendingCookies.has(key),
      isRandomized: isRandomizedCookieName(cookie.name) || volatile.has(key),
    });
    cookies.push({
      name: cookie.name,
      domain: cookie.domain,
      category: cookie.category,
      presenceRatio,
      inBaseline,
      inCurrent,
      classification,
    });
  }

  return {
    comparedTo,
    windowSize,
    hosts,
    cookies,
    hashChanged: current.hash !== against.hash,
  };
}

/**
 * compares a sweep against its baseline with the site's recent history as
 * context, and splits the differences into alerts and noise.
 *
 * @param current the fingerprint produced by the sweep under analysis
 * @param against the approved baseline, the previous sweep, or null when neither exists
 * @param window up to N fingerprints scanned before this one
 * @param comparedTo which of the two `against` is; `none` when it is null
 * @param options the window rules and the pending sets
 * @returns the split verdict, or a refusal when the two generations differ
 */
export function analyseStability(
  current: Fingerprint,
  against: Fingerprint | null,
  window: readonly Fingerprint[],
  comparedTo: DiffBasis,
  options: StabilityOptions = {},
): StableDiffResult {
  if (!against) {
    return {
      comparedTo: "none",
      windowSize: 0,
      alerts: { hostsAdded: [], hostsRemoved: [], cookiesAdded: [], cookiesRemoved: [] },
      noise: { flapping: [], missingOnce: [], pending: [] },
      noiseCount: 0,
      hashChanged: false,
    };
  }
  if (!isComparable(current, against)) {
    return { comparedTo: "incompatible", reason: INCOMPATIBLE_REASON };
  }

  const table = stabilityTable(current, against, window, comparedTo, options);

  const noise: DriftNoise = { flapping: [], missingOnce: [], pending: [] };
  const bucket = (entry: NoiseEntry): void => {
    if (entry.classification === "flapping") noise.flapping.push(entry);
    else if (entry.classification === "missing-once") noise.missingOnce.push(entry);
    else if (entry.classification === "pending") noise.pending.push(entry);
  };
  for (const entry of table.hosts) bucket({ kind: "host", ...entry });
  for (const entry of table.cookies) bucket({ kind: "cookie", ...entry });

  return {
    comparedTo: table.comparedTo,
    windowSize: table.windowSize,
    alerts: {
      hostsAdded: table.hosts.filter(isAddition),
      hostsRemoved: table.hosts.filter((e) => e.classification === "gone"),
      cookiesAdded: table.cookies.filter(isAddition),
      cookiesRemoved: table.cookies.filter((e) => e.classification === "gone"),
    },
    noise,
    noiseCount: noise.flapping.length + noise.missingOnce.length + noise.pending.length,
    hashChanged: table.hashChanged,
  };
}

/** an entry that appeared and is not explained by rotation */
function isAddition(entry: StabilityFacts): boolean {
  return entry.classification === "new" || entry.classification === "returning";
}

/**
 * whether a verdict contains anything a person should act on.
 *
 * @param diff the verdict
 * @returns true when any alert list has an entry
 */
export function hasAlerts(diff: StableDiff): boolean {
  const { hostsAdded, hostsRemoved, cookiesAdded, cookiesRemoved } = diff.alerts;
  return (
    hostsAdded.length > 0 ||
    hostsRemoved.length > 0 ||
    cookiesAdded.length > 0 ||
    cookiesRemoved.length > 0
  );
}

/**
 * the keys an alerting verdict parks in the site's pending sets, so a finding is
 * reported once rather than on every sweep until someone acts on it.
 *
 * @param diff the verdict
 * @returns the registrable domains and cookie keys that alerted
 */
export function alertKeys(diff: StableDiff): { domains: string[]; cookies: string[] } {
  const domains = [...diff.alerts.hostsAdded, ...diff.alerts.hostsRemoved].map(
    (entry) => entry.registrableDomain,
  );
  const cookies = [...diff.alerts.cookiesAdded, ...diff.alerts.cookiesRemoved].map((entry) =>
    cookieKey(entry),
  );
  return { domains: [...new Set(domains)], cookies: [...new Set(cookies)] };
}
