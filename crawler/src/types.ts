/**
 * shared type definitions for the scanner pipeline.
 *
 * data flows: crawler → classifier → result-writer → supabase.
 * every type here maps to either a DB column constraint or an intermediate
 * accumulator used between pipeline stages.
 */

// ---------------------------------------------------------------------------
// category enums — match CHECK constraints in detected_cookies / detected_trackers
// ---------------------------------------------------------------------------

/**
 * the classifier's category enums live in `@pixel-patrol/shared`, because the
 * fingerprint carries them across the wire to the agent and one definition is
 * the whole point of that package. they still map to the CHECK constraints on
 * detected_cookies.category and detected_trackers.category.
 *
 * TrackerCategory has NO `necessary` — a tracker is never necessary by
 * definition, and the classifier must enforce that.
 */
import type { CookieCategory, TrackerCategory, TrackerType } from "@pixel-patrol/shared";

export type { CookieCategory, TrackerCategory, TrackerType };

/** how the category was determined — maps to detected_cookies.category_source CHECK */
export type CategorySource = "auto" | "manual";

// ---------------------------------------------------------------------------
// crawler output — raw data before classification
// ---------------------------------------------------------------------------

/** a cookie as collected by the crawler, before classification */
export interface RawCookie {
  name: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
  durationSeconds: number | null;
  foundOnUrl: string;
  initiatorScript: string | null;
  isFirstParty: boolean;
}

/** a third-party request detected by the crawler, before classification */
export interface RawTracker {
  url: string;
  domain: string;
  type: TrackerType;
  foundOnUrl: string;
}

// ---------------------------------------------------------------------------
// classifier output — enriched with category + vendor info
// ---------------------------------------------------------------------------

/** a cookie after classification — ready for DB insertion */
export interface ClassifiedCookie extends RawCookie {
  category: CookieCategory;
  categorySource: CategorySource;
  description: string | null;
}

/** a tracker after classification — ready for DB insertion */
export interface ClassifiedTracker extends RawTracker {
  vendorName: string | null;
  category: TrackerCategory;
}

// ---------------------------------------------------------------------------
// page-level and scan-level results
// ---------------------------------------------------------------------------

/** per-page crawl result */
export interface PageResult {
  url: string;
  statusCode: number | null;
  loadTimeMs: number;
  cookiesFound: number;
  error: string | null;
}

/** summary JSONB shape stored in scans.summary */
export interface ScanSummary {
  memoryWarning: boolean;
  preConsentNonNecessaryCount: number;
  unclassifiedCount: number;
  categoryBreakdown: Record<CookieCategory, number>;
}

/** full scan result — the accumulator passed from crawler to result-writer */
export interface ScanResult {
  siteId: string;
  scanJobId: string;
  pagesScanned: number;
  pages: PageResult[];
  cookies: ClassifiedCookie[];
  trackers: ClassifiedTracker[];
  complianceScore: number;
  summary: ScanSummary;
}

// ---------------------------------------------------------------------------
// crawler options
// ---------------------------------------------------------------------------

/** configuration passed into the crawler's entry point */
export interface CrawlerOptions {
  siteUrl: string;
  siteId: string;
  scanJobId: string;
  pagesToScan: number;
  signal: AbortSignal;
  /** called after each page is visited — used by run-scan-job to update progress */
  onProgress?: (pagesScanned: number, pagesDiscovered: number) => void;
}
