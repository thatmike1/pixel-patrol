/**
 * the drift diff — a pure set comparison between two fingerprints.
 *
 * deliberately not the model's job. an LLM asked to eyeball two host lists will
 * occasionally miss one or invent one, and a missed marketing pixel is the exact
 * failure this product exists to prevent. the model decides what a difference
 * means; this file decides what the difference is.
 *
 * hosts are compared by registrable domain (eTLD+1), not by hostname. sharded
 * CDN hosts rotate between sweeps — `d15-a.sdn.cz` one day, `d21-a.sdn.cz` the
 * next — and comparing hostnames would report drift on every single sweep of
 * every site using one. the rotation is noise; a new registrable domain is the
 * signal. cookies keep (name, domain) identity, since a cookie's domain does not
 * rotate that way.
 *
 * a set difference alone is still not enough on a commercial site: programmatic
 * ad slots load a *different vendor* on every pageview, so the set moves without
 * the site changing. that second layer lives in `stability.ts` and consumes what
 * this file produces.
 */

import type { Fingerprint, FingerprintCookie, FingerprintHost } from "./fingerprint.js";

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

/** which snapshot the current sweep was measured against */
export type DiffBasis = "baseline" | "previous" | "none";

/** a registrable domain that appeared or disappeared between two sweeps */
export interface HostDelta {
  /** the unit of comparison, e.g. `facebook.net` */
  registrableDomain: string;
  /** one full hostname from the group, e.g. `connect.facebook.net` */
  host: string;
  vendor: string | null;
  category: string;
}

/** a cookie that appeared or disappeared between two sweeps */
export interface CookieDelta {
  name: string;
  domain: string;
  category: string;
}

/** the comparison, as returned when the two sides are comparable */
export interface FingerprintDiff {
  comparedTo: DiffBasis;
  hostsAdded: HostDelta[];
  hostsRemoved: HostDelta[];
  cookiesAdded: CookieDelta[];
  cookiesRemoved: CookieDelta[];
  hashChanged: boolean;
}

/**
 * returned instead of a diff when the two fingerprints come from different
 * schema generations.
 *
 * generation 1 documents carry no `registrableDomain`, so every host in them
 * would fall back to its hostname and a generation 1 vs 2 comparison would
 * report the site's entire tracker set as removed and re-added. refusing is the
 * only honest answer; re-baselining is the recovery.
 */
export interface IncompatibleDiff {
  comparedTo: "incompatible";
  reason: string;
}

/** what a diff call hands back */
export type DiffResult = FingerprintDiff | IncompatibleDiff;

/** narrows a diff result to the refusal case */
export function isIncompatible(result: { comparedTo: string }): result is IncompatibleDiff {
  return result.comparedTo === "incompatible";
}

/** the reason string a cross-generation refusal carries */
export const INCOMPATIBLE_REASON = "fingerprint schema generation differs";

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/**
 * the identity of a host in the diff: its registrable domain, falling back to
 * the hostname on a generation 1 document that never carried one.
 *
 * @param host the host entry
 * @returns the key it is compared under
 */
export function hostKey(host: FingerprintHost): string {
  return host.registrableDomain ?? host.host;
}

/**
 * the identity of a cookie in the diff: name scoped to the domain that set it.
 *
 * @param cookie the cookie entry
 * @returns the key it is compared under
 */
export function cookieKey(cookie: Pick<FingerprintCookie, "name" | "domain">): string {
  return `${cookie.domain} ${cookie.name}`;
}

/** the fields of a cookie the model is shown for an added or removed entry */
export function toCookieDelta(cookie: FingerprintCookie): CookieDelta {
  return { name: cookie.name, domain: cookie.domain, category: cookie.category };
}

/**
 * collapses hosts into one entry per registrable domain.
 *
 * the representative is the first member carrying a vendor, falling back to the
 * first member outright. across a sharded CDN group only some entries are
 * usually attributed, and naming the attributed one tells the model far more
 * than an arbitrary shard would. the crawler sorts `hosts` by hostname, so
 * "first" is stable across sweeps.
 *
 * @param hosts the fingerprint's host list
 * @returns one delta per registrable domain, keyed by it
 */
export function groupByRegistrableDomain(hosts: FingerprintHost[]): Map<string, HostDelta> {
  const groups = new Map<string, HostDelta>();

  for (const entry of hosts) {
    const key = hostKey(entry);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        registrableDomain: key,
        host: entry.host,
        vendor: entry.vendor,
        category: entry.category,
      });
      continue;
    }
    if (existing.vendor === null && entry.vendor !== null) {
      groups.set(key, {
        registrableDomain: key,
        host: entry.host,
        vendor: entry.vendor,
        category: entry.category,
      });
    }
  }

  return groups;
}

/**
 * whether two fingerprints were written under the same hash generation.
 *
 * an absent schemaVersion is generation 1, which is not comparable with
 * anything — including another generation 1 document, whose hosts carry no
 * registrable domain to compare on.
 *
 * @param current the sweep under analysis
 * @param against the snapshot it would be measured by
 * @returns true when a comparison is sound
 */
export function isComparable(current: Fingerprint, against: Fingerprint): boolean {
  return (
    current.schemaVersion !== undefined &&
    against.schemaVersion !== undefined &&
    current.schemaVersion === against.schemaVersion
  );
}

/**
 * items of `left` whose key is absent from `right`, in `left`'s order.
 *
 * the crawler sorts fingerprint arrays, so the output inherits a stable order
 * without sorting again.
 */
function missingFrom<T>(left: T[], right: T[], key: (item: T) => string): T[] {
  const present = new Set(right.map(key));
  return left.filter((item) => !present.has(key(item)));
}

/** entries of `left` whose registrable domain is absent from `right` */
function domainsMissingFrom(
  left: Map<string, HostDelta>,
  right: Map<string, HostDelta>,
): HostDelta[] {
  return [...left.entries()].filter(([key]) => !right.has(key)).map(([, delta]) => delta);
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

/**
 * compares a sweep's fingerprint against the snapshot it should be measured by.
 *
 * @param current the fingerprint produced by the sweep under analysis
 * @param against the baseline or previous fingerprint, or null when there is none
 * @param comparedTo which of the two `against` is; `none` when it is null
 * @returns the four delta lists plus whether the drift hash moved, or a refusal
 *   when the two fingerprints come from different schema generations
 */
export function diffFingerprints(
  current: Fingerprint,
  against: Fingerprint | null,
  comparedTo: DiffBasis,
): DiffResult {
  if (!against) {
    return {
      comparedTo: "none",
      hostsAdded: [],
      hostsRemoved: [],
      cookiesAdded: [],
      cookiesRemoved: [],
      hashChanged: false,
    };
  }

  if (!isComparable(current, against)) {
    return { comparedTo: "incompatible", reason: INCOMPATIBLE_REASON };
  }

  const currentHosts = groupByRegistrableDomain(current.hosts);
  const againstHosts = groupByRegistrableDomain(against.hosts);

  return {
    comparedTo,
    hostsAdded: domainsMissingFrom(currentHosts, againstHosts),
    hostsRemoved: domainsMissingFrom(againstHosts, currentHosts),
    cookiesAdded: missingFrom(current.cookies, against.cookies, cookieKey).map(toCookieDelta),
    cookiesRemoved: missingFrom(against.cookies, current.cookies, cookieKey).map(toCookieDelta),
    hashChanged: current.hash !== against.hash,
  };
}
