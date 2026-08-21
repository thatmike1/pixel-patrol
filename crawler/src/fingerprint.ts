/**
 * building a fingerprint from a scan result.
 *
 * the fingerprint's shape, its hash definition and its schema generation live in
 * `@pixel-patrol/shared`, because the agent reads exactly what this writes and
 * the two used to keep hand-synced copies of those types. this file is the part
 * only the crawler needs: turning a `ScanResult` into that shape, which is where
 * the registrable domain is derived and where the canonical ordering is applied.
 *
 * determinism is the contract:
 *
 *   - arrays are sorted by a total order that does not depend on crawl order
 *   - the hash covers ONLY registrable domains and cookie name+domain, so a
 *     cookie whose max-age ticks down between sweeps does not read as drift
 *   - cookie VALUES are never carried into a fingerprint (they are session
 *     tokens and identifiers; storing them would be the privacy leak this
 *     tool exists to find)
 */

import {
  compareStrings,
  FINGERPRINT_SCHEMA_VERSION,
  fingerprintHash,
} from "@pixel-patrol/shared";
import type { Fingerprint, FingerprintHost, FingerprintCookie } from "@pixel-patrol/shared";
import { getDomain } from "tldts";

import type { ScanResult } from "./types.js";

// the rest of the crawler imports the fingerprint shape from here, where it used
// to be defined; re-exported so the shared move stays invisible to those files
export {
  canonicalJson,
  FINGERPRINT_SCHEMA_VERSION,
  fingerprintHash,
} from "@pixel-patrol/shared";
export type {
  Fingerprint,
  FingerprintCookie,
  FingerprintHost,
  FingerprintMeta,
  FingerprintSchemaVersion,
  HashableFingerprint,
} from "@pixel-patrol/shared";

/** identifying metadata for the sweep that produced a fingerprint */
interface Meta {
  siteId: string;
  sweepId: string;
  siteUrl: string;
  scannedAt: string;
}

/**
 * builds a fingerprint from a raw scan result.
 *
 * third-party hosts are deduped by FULL host name (the crawler already dedupes
 * trackers by domain, but a fingerprint that silently depended on that would
 * be fragile) and both arrays are sorted into their canonical order. the
 * registrable domain is derived per host and collapsed only inside the hash,
 * so display keeps every hostname the site actually contacted.
 *
 * @param result the classified scan output
 * @param meta the sweep's identity
 * @returns the fingerprint, ready to write
 */
export function buildFingerprint(result: ScanResult, meta: Meta): Fingerprint {
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

  const hosts = [...byHost.values()].sort((a, b) => compareStrings(a.host, b.host));

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
    schemaVersion: FINGERPRINT_SCHEMA_VERSION,
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
