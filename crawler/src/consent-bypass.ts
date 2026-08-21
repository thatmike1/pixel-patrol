/**
 * consent banner bypass — clicks the "accept all" button on known CMP
 * implementations so the scanner can see all cookies a site sets after
 * consent.
 *
 * the selector list is ordered from most-specific (Cookiebot) to most-generic
 * (Czech-flavored CSS classes). we try each in order and click the first
 * visible match. this is deliberately non-fatal — if no banner is found or
 * the click fails, the scan continues (pre-consent cookies are still valuable
 * as a compliance signal).
 */

import type { Page } from "playwright";
import type { Logger } from "pino";

/** ordered list of "accept all" button selectors for known CMPs */
const CONSENT_SELECTORS = [
  // Cookiebot
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  // Complianz (popular WordPress plugin)
  ".cmplz-btn.cmplz-accept",
  // CookieConsent (Osano)
  ".cc-allow",
  // CookieFirst
  '[data-cookiefirst-action="accept"]',
  // OneTrust
  "#onetrust-accept-btn-handler",
  // generic — covers many custom implementations
  'button[id*="accept"]',
  'button[class*="accept-all"]',
  // Czech generic patterns
  ".cookies-accept",
  ".cookie-accept",
];

/** how long to wait for a consent banner to appear */
const BANNER_WAIT_MS = 2_000;

/** how long to wait after clicking for cookies to settle */
const SETTLE_WAIT_MS = 1_000;

/**
 * attempts to dismiss a consent banner by clicking "accept all".
 * non-fatal — errors are logged as warnings and swallowed.
 */
export async function bypassConsentBanner(
  page: Page,
  log: Logger,
): Promise<void> {
  try {
    // wait a short time for any consent banner to render
    await page.waitForTimeout(BANNER_WAIT_MS);

    for (const selector of CONSENT_SELECTORS) {
      const button = page.locator(selector).first();
      const isVisible = await button.isVisible().catch(() => false);
      if (isVisible) {
        await button.click({ timeout: 2_000 });
        log.info({ selector }, "consent banner dismissed");
        // wait for the CMP to set its cookies
        await page.waitForTimeout(SETTLE_WAIT_MS);
        return;
      }
    }

    log.debug("no consent banner detected");
  } catch (err) {
    log.warn({ err }, "consent bypass failed (non-fatal)");
  }
}
