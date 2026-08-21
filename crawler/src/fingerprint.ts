/**
 * fingerprint — the deterministic, diffable snapshot of what a site loads.
 *
 * the whole product is diffing consecutive fingerprints of the same site, so
 * determinism is the contract here, not a nicety:
 *
 *   - arrays are sorted by a total order that does not depend on crawl order
 *   - the hash covers ONLY registrable domains and cookie name+domain, so a
 *     cookie whose max-age ticks down between sweeps does not read as drift
 *   - cookie VALUES are never carried into a fingerprint (they are session
 *     tokens and identifiers; storing them would be the privacy leak this
 *     tool exists to find)
 */

import { createHash } from "node:crypto";

import { getDomain } from "tldts";

import type {
  CookieCategory,
  ScanResult,
  TrackerCategory,
  TrackerType,
} from "./types.js";

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

/** a third-party host observed loading resources on the site */
export interface FingerprintHost {
  /** the full hostname exactly as observed, kept for display */
  host: string;
  /**
   * the registrable domain (eTLD+1) of `host`, or `host` itself when there is
   * no registrable domain to derive (an IP literal, or a suffix-only name).
   * this is the unit the hash counts, not `host`.
   */
  registrableDomain: string;
  vendor: string | null;
  category: TrackerCategory;
  type: TrackerType;
}

/** a cookie observed during the sweep — identity and metadata only, never a value */
export interface FingerprintCookie {
  name: string;
  domain: string;
  path: string;
  category: CookieCategory;
  isFirstParty: boolean;
  durationSeconds: number | null;
}

/** one sweep's snapshot of a site, stored at sites/{siteId}/fingerprints/{sweepId} */
export interface Fingerprint {
  siteId: string;
  sweepId: string;
  siteUrl: string;
  scannedAt: string;
  pagesScanned: number;
  hosts: FingerprintHost[];
  cookies: FingerprintCookie[];
  preConsentNonNecessaryCount: number;
  complianceScore: number;
  hash: string;
}

/** identifying metadata for the sweep that produced a fingerprint */
export interface FingerprintMeta {
  siteId: string;
  sweepId: string;
  siteUrl: string;
  scannedAt: string;
}

/** the subset of a fingerprint the hash is computed over */
export type HashableFingerprint = Pick<Fingerprint, "hosts" | "cookies">;

// ---------------------------------------------------------------------------
// canonical serialization
// ---------------------------------------------------------------------------

/** anything that survives a JSON round-trip — the input domain of canonicalJson */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * serializes a value to JSON with object keys in a stable (lexicographic)
 * order at every depth. array order is preserved — callers sort arrays
 * themselves, because the right ordering key is domain knowledge.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`,
  );
  return `{${entries.join(",")}}`;
}

// ---------------------------------------------------------------------------
// hashing
// ---------------------------------------------------------------------------

/**
 * computes the drift hash: sha256 over the canonical JSON of the unique
 * registrable domains plus cookie name+domain pairs, and nothing else.
 *
 * deliberately narrow on two axes.
 *
 * it hashes registrable domains rather than full hostnames because CDNs and
 * ad networks shard third-party requests across rotating numbered hosts
 * (`d15-a.sdn.cz`, `d21-a.sdn.cz`, `30.onegar-ko.imedia.cz`, ...). those names
 * are assigned per request, so hashing them would make an unchanged site
 * produce a different hash on every single sweep. collapsing to `sdn.cz` and
 * `imedia.cz` means the hash moves when the site starts talking to a NEW
 * organization, which is the question the product actually asks. the full
 * hostnames stay in `hosts[]` for display.
 *
 * it also ignores category, vendor, path, duration and compliance score: those
 * move for reasons that are not "this site started loading something new".
 */
export function fingerprintHash(fp: HashableFingerprint): string {
  const hosts = [...new Set(fp.hosts.map((h) => h.registrableDomain))].sort(
    compareStrings,
  );
  const cookies = fp.cookies
    .map((c) => ({ domain: c.domain, name: c.name }))
    .sort(
      (a, b) =>
        compareStrings(a.name, b.name) || compareStrings(a.domain, b.domain),
    );

  return createHash("sha256")
    .update(canonicalJson({ cookies, hosts }))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

/**
 * builds a fingerprint from a raw scan result.
 *
 * third-party hosts are deduped by FULL host name (the crawler already dedupes
 * trackers by domain, but a fingerprint that silently depended on that would
 * be fragile) and both arrays are sorted into their canonical order. the
 * registrable domain is derived per host and collapsed only inside the hash,
 * so display keeps every hostname the site actually contacted.
 */
export function buildFingerprint(
  result: ScanResult,
  meta: FingerprintMeta,
): Fingerprint {
  const byHost = new Map<string, FingerprintHost>();
  for (const tracker of result.trackers) {
    const host = tracker.domain.toLowerCase();
    if (byHost.has(host)) continue;
    byHost.set(host, {
      host,
      // tldts ships the public suffix list in-process; no network lookup
      registrableDomain: getDomain(host) ?? host,
      vendor: tracker.vendorName,
      category: tracker.category,
      type: tracker.type,
    });
  }

  const hosts = [...byHost.values()].sort((a, b) =>
    compareStrings(a.host, b.host),
  );

  const cookies: FingerprintCookie[] = result.cookies
    .map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      category: c.category,
      isFirstParty: c.isFirstParty,
      durationSeconds: c.durationSeconds,
    }))
    .sort(
      (a, b) =>
        compareStrings(a.name, b.name) ||
        compareStrings(a.domain, b.domain) ||
        compareStrings(a.path, b.path),
    );

  return {
    siteId: meta.siteId,
    sweepId: meta.sweepId,
    siteUrl: meta.siteUrl,
    scannedAt: meta.scannedAt,
    pagesScanned: result.pagesScanned,
    hosts,
    cookies,
    preConsentNonNecessaryCount: result.summary.preConsentNonNecessaryCount,
    complianceScore: result.complianceScore,
    hash: fingerprintHash({ hosts, cookies }),
  };
}

/**
 * locale-independent string comparison. `Array.prototype.sort` without a
 * comparator, and `localeCompare`, both vary with environment; the crawler
 * runs with a Czech locale set, so ordering has to be pinned explicitly.
 */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
