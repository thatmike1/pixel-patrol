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
 */

import type { Fingerprint, FingerprintCookie, FingerprintHost } from "./types.js";

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

/** the comparison, as returned to the model when the two sides are comparable */
export interface FingerprintDiff {
  comparedTo: DiffBasis;
  hostsAdded: HostDelta[];
  hostsRemoved: HostDelta[];
  cookiesAdded: CookieDelta[];
  cookiesRemoved: CookieDelta[];
  hashChanged: boolean;
  // TODO(stability-score): rank each delta by how many of the last N sweeps the
  // domain or cookie appeared in, so a tag that flickers in and out of an ad
  // rotation reads differently from one that just showed up for the first time.
  // additive: a new optional field per delta plus a `stability` block here.
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

/** what `diff_against_baseline` hands back */
export type DiffResult = FingerprintDiff | IncompatibleDiff;

/** narrows a diff result to the refusal case */
export function isIncompatible(result: DiffResult): result is IncompatibleDiff {
  return result.comparedTo === "incompatible";
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/**
 * the identity of a host in the diff: its registrable domain, falling back to
 * the hostname on a generation 1 document that never carried one.
 */
function hostKey(host: FingerprintHost): string {
  return host.registrableDomain ?? host.host;
}

/** the identity of a cookie in the diff: name scoped to the domain that set it */
function cookieKey(cookie: FingerprintCookie): string {
  return `${cookie.domain} ${cookie.name}`;
}

/** the fields of a cookie the model is shown for an added or removed entry */
function toCookieDelta(cookie: FingerprintCookie): CookieDelta {
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
 */
function groupByRegistrableDomain(hosts: FingerprintHost[]): Map<string, HostDelta> {
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

  // an absent schemaVersion is generation 1, which is not comparable with
  // anything — including another generation 1 document, whose hosts carry no
  // registrable domain to compare on
  if (
    current.schemaVersion === undefined ||
    against.schemaVersion === undefined ||
    current.schemaVersion !== against.schemaVersion
  ) {
    return {
      comparedTo: "incompatible",
      reason: "fingerprint schema generation differs",
    };
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
