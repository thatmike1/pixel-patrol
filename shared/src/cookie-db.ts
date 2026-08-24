/**
 * known cookie database — loads known-cookies.json on first access and
 * provides O(1) exact-match lookups plus regex-based pattern matching.
 *
 * the JSON file is seeded from Open Cookie Database, Cookiepedia, and
 * Czech-specific sources (Shoptet, Heureka, Sklik, Seznam, etc.).
 *
 * shared for the same reason as the tracker table: the redline the agent writes
 * quotes cookie purposes and durations out of this file, and they have to be
 * the ones the scanner classified against.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { CookieCategory } from "./fingerprint.js";

/** shape of a single entry in known-cookies.json */
export interface KnownCookie {
  name: string;
  pattern: boolean;
  category: CookieCategory;
  vendor: string;
  description_cs: string;
  typical_duration_seconds: number | null;
}

interface CookieDbFile {
  cookies: KnownCookie[];
}

/** compiled pattern entry — glob `*` converted to regex */
interface PatternEntry {
  regex: RegExp;
  cookie: KnownCookie;
}

let exactMap: Map<string, KnownCookie> | null = null;
let patterns: PatternEntry[] | null = null;

/**
 * loads and indexes the cookie database on first call.
 * uses synchronous file read — acceptable because this runs once in a
 * worker process, not in a request handler.
 */
function ensureLoaded(): void {
  if (exactMap !== null) return;

  const thisDir = dirname(fileURLToPath(import.meta.url));
  const dataPath = resolve(thisDir, "..", "data", "known-cookies.json");
  const raw: CookieDbFile = JSON.parse(readFileSync(dataPath, "utf-8"));

  exactMap = new Map();
  patterns = [];

  for (const cookie of raw.cookies) {
    if (cookie.pattern) {
      // convert glob `*` to regex: `_ga_*` → `/^_ga_.*$/`
      const escaped = cookie.name
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      patterns.push({
        regex: new RegExp(`^${escaped}$`),
        cookie,
      });
    } else {
      exactMap.set(cookie.name.toLowerCase(), cookie);
    }
  }
}

/**
 * looks up a cookie by name. tries exact match first, then pattern match.
 * returns null if the cookie is unknown.
 */
export function lookupCookie(name: string): KnownCookie | null {
  ensureLoaded();

  // exact match (case-insensitive)
  const exact = exactMap!.get(name.toLowerCase());
  if (exact) return exact;

  // pattern match
  for (const entry of patterns!) {
    if (entry.regex.test(name)) return entry.cookie;
  }

  return null;
}

/**
 * every entry in the cookie table, exact and pattern alike.
 *
 * see {@link allTrackers} — the redline needs to search the table by vendor,
 * not only by cookie name.
 *
 * @returns the entries, exact ones first
 */
export function allCookies(): KnownCookie[] {
  ensureLoaded();
  return [...exactMap!.values(), ...patterns!.map((entry) => entry.cookie)];
}
