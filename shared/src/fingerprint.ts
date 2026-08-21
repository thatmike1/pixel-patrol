/**
 * the fingerprint: the deterministic, diffable snapshot of what a site loads.
 *
 * this file is the single definition of that shape. the crawler builds
 * fingerprints and the agent reads them, and the two used to hold hand-synced
 * copies of these types — which drifted twice, and a drifted fingerprint type
 * makes the differ silently stop seeing hosts. one definition, two consumers.
 *
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

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

/** cookie category, as the scanner's classifier assigns it */
export type CookieCategory =
  | "necessary"
  | "analytics"
  | "marketing"
  | "functional"
  | "unclassified";

/** tracker category. no `necessary` — a tracker is never necessary by definition */
export type TrackerCategory = "analytics" | "marketing" | "functional" | "unclassified";

/** the kind of resource a third-party host served */
export type TrackerType = "script" | "pixel" | "iframe" | "font";

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
   * this is the unit the hash counts and the unit drift is measured in, not
   * `host`: sharded CDN hostnames rotate between sweeps and would otherwise
   * read as drift every single time.
   *
   * required from schema generation 2 onward. optional here only because the
   * agent still reads generation 1 documents written before the crawler
   * emitted it; the differ refuses to compare those rather than guess.
   */
  registrableDomain?: string;
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

/**
 * the generation of the hash definition this fingerprint was built under.
 *
 *   1 — hash over full hostnames. rotating CDN shards made it unstable, so an
 *       unchanged site produced a new hash on most sweeps. never shipped to a
 *       deployed image; only local smoke runs exist.
 *   2 — hash over unique registrable domains (current).
 *
 * hashes from different generations are NOT comparable. this field is metadata
 * for the differ to refuse a cross-generation compare, and is deliberately
 * excluded from the hash input: bumping the definition must not silently look
 * like the site changed.
 */
export type FingerprintSchemaVersion = 2;

/** the generation the crawler currently produces */
export const FINGERPRINT_SCHEMA_VERSION: FingerprintSchemaVersion = 2;

/** one sweep's snapshot of a site, stored at sites/{siteId}/fingerprints/{sweepId} */
export interface Fingerprint {
  /**
   * see {@link FingerprintSchemaVersion} — read this before comparing hashes.
   * absent means generation 1: a document written before the crawler stamped
   * it, whose hosts also lack `registrableDomain`.
   */
  schemaVersion?: FingerprintSchemaVersion | number;
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
 *
 * @param value the value to serialize
 * @returns its canonical JSON text
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
 *
 * @param fp the hosts and cookies to hash
 * @returns the hex sha256 digest
 */
export function fingerprintHash(fp: HashableFingerprint): string {
  const hosts = [
    ...new Set(fp.hosts.map((h) => h.registrableDomain ?? h.host)),
  ].sort(compareStrings);
  const cookies = fp.cookies
    .map((c) => ({ domain: c.domain, name: c.name }))
    .sort(
      (a, b) => compareStrings(a.name, b.name) || compareStrings(a.domain, b.domain),
    );

  return createHash("sha256").update(canonicalJson({ cookies, hosts })).digest("hex");
}

/**
 * locale-independent string comparison. `Array.prototype.sort` without a
 * comparator, and `localeCompare`, both vary with environment; the crawler
 * runs with a Czech locale set, so ordering has to be pinned explicitly.
 *
 * @param a left side
 * @param b right side
 * @returns -1, 0 or 1
 */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
