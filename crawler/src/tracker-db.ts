/**
 * known tracker database — loads known-trackers.json on first access and
 * provides domain lookups with progressive subdomain stripping.
 *
 * example: a request to `cdn.tracking.example.com` will match a DB entry
 * for `tracking.example.com` by stripping the `cdn.` prefix.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { TrackerCategory, TrackerType } from "./types.js";

/** shape of a single entry in known-trackers.json */
export interface KnownTracker {
  domain: string;
  vendor: string;
  category: TrackerCategory;
  type: TrackerType;
}

interface TrackerDbFile {
  trackers: KnownTracker[];
}

let domainMap: Map<string, KnownTracker> | null = null;

/** loads and indexes the tracker database on first call */
function ensureLoaded(): void {
  if (domainMap !== null) return;

  const thisDir = dirname(fileURLToPath(import.meta.url));
  const dataPath = resolve(thisDir, "..", "data", "known-trackers.json");
  const raw: TrackerDbFile = JSON.parse(readFileSync(dataPath, "utf-8"));

  domainMap = new Map();
  for (const tracker of raw.trackers) {
    domainMap.set(tracker.domain.toLowerCase(), tracker);
  }
}

/**
 * looks up a tracker by domain. tries exact match first, then progressively
 * strips subdomains (e.g. `cdn.hotjar.com` → `hotjar.com`).
 * returns null if the domain is unknown.
 */
export function lookupTracker(domain: string): KnownTracker | null {
  ensureLoaded();

  const normalized = domain.toLowerCase();

  // exact match
  const exact = domainMap!.get(normalized);
  if (exact) return exact;

  // progressive subdomain stripping
  const parts = normalized.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const stripped = parts.slice(i).join(".");
    const match = domainMap!.get(stripped);
    if (match) return match;
  }

  return null;
}
