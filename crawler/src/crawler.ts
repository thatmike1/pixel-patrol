/**
 * Playwright crawler — BFS page discovery with cookie/tracker collection.
 *
 * core flow:
 *   1. SSRF validate site URL
 *   2. launch headless Chromium with Czech locale
 *   3. first page: collect pre-consent cookies → bypass consent → collect all
 *   4. BFS loop: discover links, SSRF validate each, navigate, collect
 *   5. classify all cookies/trackers, calculate compliance score
 *   6. browser.close() in finally — ALWAYS
 *
 * cooperative cancellation via AbortSignal — checked at BFS loop top and
 * on the memory guard. the worker fires abort on timeout or shutdown.
 */

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page, Response } from "playwright";
import type { Logger } from "pino";

import type {
  CrawlerOptions,
  RawCookie,
  RawTracker,
  ClassifiedCookie,
  ClassifiedTracker,
  CookieCategory,
  PageResult,
  ScanResult,
  ScanSummary,
  TrackerType,
} from "./types.js";
import { validateUrl } from "./url-validator.js";
import { bypassConsentBanner } from "./consent-bypass.js";
import {
  classifyCookie,
  classifyTracker,
  calculateComplianceScore,
} from "./classifier.js";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** minimum ms between navigations — 2 req/sec rate limit */
const MIN_NAV_INTERVAL_MS = 500;

/** page navigation timeout */
const PAGE_TIMEOUT_MS = 30_000;

/** post-navigation settle time for JS/cookies */
const SETTLE_MS = 5_000;

/** abort if RSS memory exceeds this (bytes) — leaves headroom in 2GB container */
const MEMORY_LIMIT_BYTES = 1.5 * 1024 * 1024 * 1024;

/** file extensions to skip */
const SKIP_EXTENSIONS = new Set([
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".svg",
  ".zip",
  ".xml",
  ".gz",
  ".tar",
  ".mp4",
  ".mp3",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
]);

/** path prefixes to skip */
const SKIP_PATHS = ["/wp-admin", "/admin", "/wp-login"];

/** query param prefixes to strip for URL normalization */
const TRACKING_PARAMS = ["utm_", "fbclid", "gclid", "mc_", "ref", "source"];

/** max query params before we skip a URL (likely dynamic/paginated junk) */
const MAX_QUERY_PARAMS = 5;

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * crawls a site using BFS page discovery, collecting cookies and trackers.
 * returns classified results ready for the result-writer.
 */
export async function crawlSite(
  options: CrawlerOptions,
  log: Logger,
): Promise<ScanResult> {
  const { siteUrl, siteId, scanJobId, pagesToScan, signal, onProgress } =
    options;

  // SSRF validate the entry URL
  const validation = await validateUrl(siteUrl);
  if (!validation.valid) {
    throw new Error(`site URL failed SSRF validation: ${validation.reason}`);
  }

  const siteOrigin = new URL(siteUrl).origin;
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage", "--disable-gpu"],
    });

    const context = await browser.newContext({
      locale: "cs-CZ",
      timezoneId: "Europe/Prague",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
    });

    // -----------------------------------------------------------------------
    // intercept requests for tracker detection
    // -----------------------------------------------------------------------

    const rawTrackers: RawTracker[] = [];
    const rawCookiesFromHeaders: RawCookie[] = [];
    const pendingHeaderWork: Promise<void>[] = [];
    let currentPageUrl = siteUrl;

    context.on("request", (request) => {
      try {
        const reqUrl = new URL(request.url());
        if (reqUrl.origin !== siteOrigin) {
          rawTrackers.push({
            url: request.url(),
            domain: reqUrl.hostname,
            type: inferTrackerType(request.resourceType()),
            foundOnUrl: currentPageUrl,
          });
        }
      } catch {
        // invalid URL — skip
      }
    });

    // intercept Set-Cookie headers from responses — track promises to await before merge
    context.on("response", (response: Response) => {
      const p = (async () => {
        try {
          const headers = await response.headersArray();
          for (const header of headers) {
            if (header.name.toLowerCase() === "set-cookie") {
              const parsed = parseSetCookieHeader(
                header.value,
                currentPageUrl,
                siteOrigin,
              );
              if (parsed) rawCookiesFromHeaders.push(parsed);
            }
          }
        } catch {
          // response may be closed — skip
        }
      })();
      pendingHeaderWork.push(p);
    });

    const page = await context.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);

    // -----------------------------------------------------------------------
    // first page — pre-consent + consent bypass + post-consent
    // -----------------------------------------------------------------------

    const visited = new Set<string>();
    const toVisit: string[] = [];
    const queued = new Set<string>();
    const pages: PageResult[] = [];
    const allRawCookies: Map<string, RawCookie> = new Map();
    let preConsentCookieCount = 0;

    const startUrl = normalizeUrl(siteUrl);
    if (!startUrl) throw new Error("could not normalize site URL");

    // navigate to entry page
    currentPageUrl = startUrl;
    const firstPageResult = await navigatePage(page, startUrl, log);
    pages.push(firstPageResult);
    visited.add(startUrl);

    // collect pre-consent cookies
    const preConsentCookies = await collectCookies(
      context,
      page,
      startUrl,
      siteOrigin,
    );
    for (const [key, cookie] of preConsentCookies) {
      allRawCookies.set(key, cookie);
    }
    preConsentCookieCount = preConsentCookies.size;

    // bypass consent banner
    await bypassConsentBanner(page, log);

    // collect post-consent cookies
    const postConsentCookies = await collectCookies(
      context,
      page,
      startUrl,
      siteOrigin,
    );
    for (const [key, cookie] of postConsentCookies) {
      allRawCookies.set(key, cookie);
    }

    // extract links from first page
    const firstPageLinks = await extractLinks(page, siteOrigin);
    for (const link of firstPageLinks) {
      if (!visited.has(link) && !queued.has(link)) {
        queued.add(link);
        toVisit.push(link);
      }
    }

    // update first page result with cookie count
    firstPageResult.cookiesFound = postConsentCookies.size;
    onProgress?.(1, Math.min(visited.size + toVisit.length, pagesToScan));

    log.info(
      {
        pre_consent_cookies: preConsentCookieCount,
        post_consent_cookies: postConsentCookies.size,
        links_found: firstPageLinks.length,
      },
      "first page processed",
    );

    // -----------------------------------------------------------------------
    // BFS loop
    // -----------------------------------------------------------------------

    let lastNavTime = Date.now();

    while (toVisit.length > 0 && visited.size < pagesToScan) {
      // cooperative cancellation
      if (signal.aborted) {
        log.info("scan aborted by signal");
        break;
      }

      // memory guard
      const rss = process.memoryUsage().rss;
      if (rss > MEMORY_LIMIT_BYTES) {
        log.warn(
          { rss_mb: Math.round(rss / 1024 / 1024) },
          "memory limit reached, stopping crawl",
        );
        break;
      }

      const url = toVisit.shift()!;
      if (visited.has(url)) continue;

      // SSRF validate discovered URLs
      const urlCheck = await validateUrl(url);
      if (!urlCheck.valid) {
        log.debug({ url, reason: urlCheck.reason }, "skipping URL (SSRF)");
        continue;
      }

      // rate limit
      const elapsed = Date.now() - lastNavTime;
      if (elapsed < MIN_NAV_INTERVAL_MS) {
        await new Promise((r) => setTimeout(r, MIN_NAV_INTERVAL_MS - elapsed));
      }

      currentPageUrl = url;
      const pageResult = await navigatePage(page, url, log);
      lastNavTime = Date.now();
      visited.add(url);

      // collect cookies
      const pageCookies = await collectCookies(context, page, url, siteOrigin);
      for (const [key, cookie] of pageCookies) {
        allRawCookies.set(key, cookie);
      }
      pageResult.cookiesFound = pageCookies.size;
      pages.push(pageResult);

      // extract links
      const links = await extractLinks(page, siteOrigin);
      for (const link of links) {
        if (!visited.has(link) && !queued.has(link)) {
          queued.add(link);
          toVisit.push(link);
        }
      }

      const discovered = Math.min(visited.size + toVisit.length, pagesToScan);
      log.info(
        {
          page: pages.length,
          discovered,
          cookies: pageCookies.size,
          url,
        },
        "page scanned",
      );

      onProgress?.(pages.length, discovered);
    }

    // -----------------------------------------------------------------------
    // merge header-collected cookies into allRawCookies
    // -----------------------------------------------------------------------

    // drain any in-flight response header extractions before merging
    await Promise.all(pendingHeaderWork);

    for (const cookie of rawCookiesFromHeaders) {
      const key = cookieKey(cookie.name, cookie.domain, cookie.path);
      if (!allRawCookies.has(key)) {
        allRawCookies.set(key, cookie);
      }
    }

    // -----------------------------------------------------------------------
    // classify
    // -----------------------------------------------------------------------

    const cookies: ClassifiedCookie[] = Array.from(allRawCookies.values()).map(
      classifyCookie,
    );
    const trackers: ClassifiedTracker[] =
      deduplicateTrackers(rawTrackers).map(classifyTracker);

    // count pre-consent non-necessary cookies
    const preConsentKeys = new Set(preConsentCookies.keys());
    let preConsentNonNecessary = 0;
    for (const cookie of cookies) {
      const key = cookieKey(cookie.name, cookie.domain, cookie.path);
      if (preConsentKeys.has(key) && cookie.category !== "necessary") {
        preConsentNonNecessary++;
      }
    }

    const unclassifiedCount = cookies.filter(
      (c) => c.category === "unclassified",
    ).length;
    const memoryWarning = process.memoryUsage().rss > MEMORY_LIMIT_BYTES * 0.9;

    const categoryBreakdown: Record<CookieCategory, number> = {
      necessary: 0,
      analytics: 0,
      marketing: 0,
      functional: 0,
      unclassified: 0,
    };
    for (const c of cookies) {
      categoryBreakdown[c.category]++;
    }

    const summary: ScanSummary = {
      memoryWarning,
      preConsentNonNecessaryCount: preConsentNonNecessary,
      unclassifiedCount,
      categoryBreakdown,
    };

    const complianceScore = calculateComplianceScore(
      cookies,
      trackers,
      summary,
    );

    log.info(
      {
        pages_scanned: pages.length,
        cookies: cookies.length,
        trackers: trackers.length,
        score: complianceScore,
      },
      "classification complete",
    );

    return {
      siteId,
      scanJobId,
      pagesScanned: pages.length,
      pages,
      cookies,
      trackers,
      complianceScore,
      summary,
    };
  } finally {
    // ALWAYS close the browser — regardless of error/abort
    if (browser) {
      try {
        await browser.close();
      } catch {
        // browser may already be closed — ignore
      }
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** navigates to a URL, waits for settle, returns page result */
async function navigatePage(
  page: Page,
  url: string,
  log: Logger,
): Promise<PageResult> {
  const start = Date.now();
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    // settle time for JS to run and set cookies
    await page.waitForTimeout(SETTLE_MS);
    return {
      url,
      statusCode: response?.status() ?? null,
      loadTimeMs: Date.now() - start,
      cookiesFound: 0,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug({ url, err: message }, "page navigation failed");
    return {
      url,
      statusCode: null,
      loadTimeMs: Date.now() - start,
      cookiesFound: 0,
      error: message,
    };
  }
}

/**
 * collects cookies from 3 sources and merges by name+domain+path:
 *   1. context.cookies() — Playwright's cookie jar (includes httpOnly)
 *   2. document.cookie — JS-visible cookies
 *   3. (Set-Cookie headers are collected separately via response interception)
 */
async function collectCookies(
  context: BrowserContext,
  page: Page,
  pageUrl: string,
  siteOrigin: string,
): Promise<Map<string, RawCookie>> {
  const cookies = new Map<string, RawCookie>();
  const siteHostname = new URL(siteOrigin).hostname;

  // source 1: Playwright cookie jar
  try {
    const ctxCookies = await context.cookies();
    for (const c of ctxCookies) {
      const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
      const key = cookieKey(c.name, domain, c.path);
      cookies.set(key, {
        name: c.name,
        domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        durationSeconds:
          c.expires > 0 ? Math.round(c.expires - Date.now() / 1000) : null,
        foundOnUrl: pageUrl,
        initiatorScript: null,
        isFirstParty: isFirstParty(domain, siteHostname),
      });
    }
  } catch {
    // context may be closed
  }

  // source 2: document.cookie (catches JS-only cookies not in Playwright jar)
  try {
    const docCookies = (await page.evaluate("document.cookie")) as string;
    if (docCookies) {
      for (const pair of docCookies.split(";")) {
        const [name, ...rest] = pair.trim().split("=");
        if (!name) continue;
        const key = cookieKey(name.trim(), siteHostname, "/");
        if (!cookies.has(key)) {
          cookies.set(key, {
            name: name.trim(),
            domain: siteHostname,
            path: "/",
            httpOnly: false,
            secure: false,
            sameSite: "Lax",
            durationSeconds: null,
            foundOnUrl: pageUrl,
            initiatorScript: null,
            isFirstParty: true,
          });
        }
      }
    }
  } catch {
    // page may be closed
  }

  return cookies;
}

/** extracts same-origin links from the page */
async function extractLinks(page: Page, siteOrigin: string): Promise<string[]> {
  try {
    const hrefs: string[] = (await page.evaluate(
      "Array.from(document.querySelectorAll('a[href]')).map(a => String(a.href)).filter(h => h.startsWith('http'))",
    )) as string[];

    const links: string[] = [];
    for (const href of hrefs) {
      try {
        const url = new URL(href);
        if (url.origin !== siteOrigin) continue;
        const normalized = normalizeUrl(href);
        if (normalized && shouldCrawl(normalized)) {
          links.push(normalized);
        }
      } catch {
        // invalid URL — skip
      }
    }
    return links;
  } catch {
    return [];
  }
}

/** normalizes a URL: strip fragments, tracking params, trailing slash, lowercase hostname */
function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    // strip fragment
    url.hash = "";
    // strip tracking params
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.some((prefix) => key.startsWith(prefix))) {
        url.searchParams.delete(key);
      }
    }
    // normalize: lowercase hostname, consistent trailing slash
    let result = url.toString();
    // remove trailing slash on path-only URLs (but keep root /)
    if (url.pathname !== "/" && result.endsWith("/")) {
      result = result.slice(0, -1);
    }
    return result;
  } catch {
    return null;
  }
}

/** checks if a URL should be crawled based on extension and path rules */
function shouldCrawl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // skip by extension
    const pathname = parsed.pathname.toLowerCase();
    for (const ext of SKIP_EXTENSIONS) {
      if (pathname.endsWith(ext)) return false;
    }
    // skip admin paths
    for (const prefix of SKIP_PATHS) {
      if (pathname.startsWith(prefix)) return false;
    }
    // skip URLs with too many query params
    if ([...parsed.searchParams].length > MAX_QUERY_PARAMS) return false;
    return true;
  } catch {
    return false;
  }
}

/** creates a unique key for cookie deduplication */
function cookieKey(name: string, domain: string, path: string): string {
  return `${name}|||${domain}|||${path}`;
}

/** checks if a cookie domain is first-party relative to the site */
function isFirstParty(cookieDomain: string, siteHostname: string): boolean {
  const cd = cookieDomain.toLowerCase();
  const sh = siteHostname.toLowerCase();
  return cd === sh || sh.endsWith(`.${cd}`);
}

/** infers tracker type from Playwright resource type */
function inferTrackerType(resourceType: string): TrackerType {
  switch (resourceType) {
    case "script":
      return "script";
    case "image":
      return "pixel";
    case "sub_frame":
    case "frame":
      return "iframe";
    case "font":
      return "font";
    default:
      return "script";
  }
}

/** deduplicates trackers by domain — keeps first occurrence */
function deduplicateTrackers(trackers: RawTracker[]): RawTracker[] {
  const seen = new Set<string>();
  const result: RawTracker[] = [];
  for (const t of trackers) {
    if (!seen.has(t.domain)) {
      seen.add(t.domain);
      result.push(t);
    }
  }
  return result;
}

/** parses a Set-Cookie header value into a RawCookie */
function parseSetCookieHeader(
  header: string,
  pageUrl: string,
  siteOrigin: string,
): RawCookie | null {
  try {
    const parts = header.split(";").map((p) => p.trim());
    const nameVal = parts[0];
    if (!nameVal) return null;
    const attrs = parts.slice(1);
    const eqIndex = nameVal.indexOf("=");
    if (eqIndex === -1) return null;

    const name = nameVal.slice(0, eqIndex).trim();
    if (!name) return null;

    const siteHostname = new URL(siteOrigin).hostname;
    let domain = siteHostname;
    let path = "/";
    let httpOnly = false;
    let secure = false;
    let sameSite = "Lax";
    let maxAge: number | null = null;

    for (const attr of attrs) {
      const lower = attr.toLowerCase();
      if (lower.startsWith("domain=")) {
        domain = attr.slice(7).trim().replace(/^\./, "");
      } else if (lower.startsWith("path=")) {
        path = attr.slice(5).trim();
      } else if (lower === "httponly") {
        httpOnly = true;
      } else if (lower === "secure") {
        secure = true;
      } else if (lower.startsWith("samesite=")) {
        sameSite = attr.slice(9).trim();
      } else if (lower.startsWith("max-age=")) {
        const val = parseInt(attr.slice(8).trim(), 10);
        if (!isNaN(val)) maxAge = val;
      }
    }

    return {
      name,
      domain,
      path,
      httpOnly,
      secure,
      sameSite,
      durationSeconds: maxAge,
      foundOnUrl: pageUrl,
      initiatorScript: null,
      isFirstParty: isFirstParty(domain, siteHostname),
    };
  } catch {
    return null;
  }
}
