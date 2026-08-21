/**
 * the drift diff — a pure set comparison between two fingerprints.
 *
 * deliberately not the model's job. an LLM asked to eyeball two host lists will
 * occasionally miss one or invent one, and a missed marketing pixel is the exact
 * failure this product exists to prevent. the model decides what a difference
 * means; this file decides what the difference is.
 *
 * identity is the host name for hosts and the (name, domain) pair for cookies,
 * matching the fields the crawler's `fingerprintHash` covers — so `hashChanged`
 * is true exactly when at least one of the four lists is non-empty.
 */

import type { Fingerprint, FingerprintCookie, FingerprintHost } from "./types.js";

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

/** which snapshot the current sweep was measured against */
export type DiffBasis = "baseline" | "previous" | "none";

/** a host that appeared or disappeared between two sweeps */
export interface HostDelta {
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

/** the full comparison, as returned to the model by `diff_against_baseline` */
export interface FingerprintDiff {
  comparedTo: DiffBasis;
  hostsAdded: HostDelta[];
  hostsRemoved: HostDelta[];
  cookiesAdded: CookieDelta[];
  cookiesRemoved: CookieDelta[];
  hashChanged: boolean;
  // TODO(stability-score): rank each delta by how many of the last N sweeps the
  // host or cookie appeared in, so a tag that flickers in and out of an ad
  // rotation reads differently from one that just showed up for the first time.
  // additive: a new optional field per delta plus a `stability` block here.
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/** the identity of a host in the diff: its name */
function hostKey(host: FingerprintHost): string {
  return host.host;
}

/** the identity of a cookie in the diff: name scoped to the domain that set it */
function cookieKey(cookie: FingerprintCookie): string {
  return `${cookie.domain} ${cookie.name}`;
}

/** the fields of a host the model is shown for an added or removed entry */
function toHostDelta(host: FingerprintHost): HostDelta {
  return { host: host.host, vendor: host.vendor, category: host.category };
}

/** the fields of a cookie the model is shown for an added or removed entry */
function toCookieDelta(cookie: FingerprintCookie): CookieDelta {
  return { name: cookie.name, domain: cookie.domain, category: cookie.category };
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

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

/**
 * compares a sweep's fingerprint against the snapshot it should be measured by.
 *
 * @param current the fingerprint produced by the sweep under analysis
 * @param against the baseline or previous fingerprint, or null when there is none
 * @param comparedTo which of the two `against` is; `none` when it is null
 * @returns the four delta lists plus whether the drift hash moved
 */
export function diffFingerprints(
  current: Fingerprint,
  against: Fingerprint | null,
  comparedTo: DiffBasis,
): FingerprintDiff {
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

  const hostsAdded = missingFrom(current.hosts, against.hosts, hostKey).map(toHostDelta);
  const hostsRemoved = missingFrom(against.hosts, current.hosts, hostKey).map(toHostDelta);
  const cookiesAdded = missingFrom(current.cookies, against.cookies, cookieKey).map(toCookieDelta);
  const cookiesRemoved = missingFrom(against.cookies, current.cookies, cookieKey).map(
    toCookieDelta,
  );

  return {
    comparedTo,
    hostsAdded,
    hostsRemoved,
    cookiesAdded,
    cookiesRemoved,
    hashChanged: current.hash !== against.hash,
  };
}
