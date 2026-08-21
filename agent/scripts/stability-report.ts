/**
 * the tuning tool: what the stability window actually thinks about a site.
 *
 * the thresholds in `@pixel-patrol/shared` (N sweeps of history, M absences
 * before a removal) are guesses until someone looks at real overnight data from
 * a real commercial site. this prints the evidence behind every classification —
 * per domain: how often it showed up, whether the baseline has it, what it was
 * called — followed by the decisions the analyst actually recorded, so a run of
 * repeated `drift` verdicts can be traced to the domains that caused it.
 *
 *   PROJECT_ID=pixel-patrol-mp ./infra/stability-report.sh smoke-trackers 5
 *
 * read-only. it writes nothing to Firestore.
 */

import {
  DEFAULT_GONE_AFTER,
  DEFAULT_STABILITY_WINDOW,
  isIncompatibleResult,
  prepareWindow,
  stabilityTable,
} from "@pixel-patrol/shared";
import type { Fingerprint, StabilityClass } from "@pixel-patrol/shared";

import { analyseDrift } from "../src/drift.js";
import { createStore } from "../src/firestore.js";
import type { Store } from "../src/firestore.js";
import { NotFoundError } from "../src/sweep-context.js";

/** the order classifications are printed in: loudest first */
const CLASS_ORDER: StabilityClass[] = [
  "new",
  "returning",
  "gone",
  "pending",
  "missing-once",
  "flapping",
  "stable",
];

/**
 * pads a cell to a width, so the table lines up without a dependency.
 *
 * @param value the cell text
 * @param width the column width
 * @param align which side to pad
 * @returns the padded cell
 */
function cell(value: string, width: number, align: "left" | "right" = "left"): string {
  if (value.length >= width) return value.slice(0, width);
  return align === "left" ? value.padEnd(width) : value.padStart(width);
}

/** a percentage with no decimals, or a dash when there is no window */
function ratio(value: number, windowSize: number): string {
  return windowSize === 0 ? "-" : `${Math.round(value * 100)}%`;
}

/** prints one aligned table of domains */
function printDomains(
  rows: { domain: string; ratio: string; inBaseline: boolean; classification: string; vendor: string }[],
): void {
  const widths = {
    domain: Math.max(6, ...rows.map((r) => r.domain.length)),
    ratio: 8,
    baseline: 8,
    classification: 13,
  };
  console.log(
    `${cell("domain", widths.domain)}  ${cell("presence", widths.ratio, "right")}  ` +
      `${cell("baseline", widths.baseline)}  ${cell("class", widths.classification)}  vendor`,
  );
  console.log("-".repeat(widths.domain + widths.ratio + widths.baseline + widths.classification + 16));
  for (const row of rows) {
    console.log(
      `${cell(row.domain, widths.domain)}  ${cell(row.ratio, widths.ratio, "right")}  ` +
        `${cell(row.inBaseline ? "yes" : "no", widths.baseline)}  ` +
        `${cell(row.classification, widths.classification)}  ${row.vendor}`,
    );
  }
}

/**
 * loads the newest fingerprint for a site, which is the sweep the report is
 * written from.
 *
 * @param store the Firestore accessors
 * @param siteId the site
 * @returns the newest fingerprint, or null when the site has never been swept
 */
async function newestFingerprint(store: Store, siteId: string): Promise<Fingerprint | null> {
  // "before the end of time" — listFingerprintsBefore is the only ordered read
  // the store exposes, and this is the operator tool, not the hot path
  const [newest] = await store.listFingerprintsBefore(siteId, "9999", 1, "");
  return newest ?? null;
}

async function main(): Promise<number> {
  const siteId = process.argv[2];
  if (!siteId) {
    console.error("usage: stability-report.ts <site-id> [window-size]");
    return 2;
  }
  const windowSize = Number(process.argv[3] ?? process.env.STABILITY_WINDOW ?? DEFAULT_STABILITY_WINDOW);
  const goneAfter = Number(process.env.GONE_AFTER ?? DEFAULT_GONE_AFTER);
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.PROJECT_ID;
  if (!projectId) {
    console.error("set GOOGLE_CLOUD_PROJECT or PROJECT_ID");
    return 2;
  }

  const store = createStore(projectId);
  const site = await store.getSite(siteId);
  if (!site) {
    console.error(`no site registered as "${siteId}"`);
    return 1;
  }

  const current = await newestFingerprint(store, siteId);
  if (!current) {
    console.error(`site "${siteId}" has no fingerprints yet`);
    return 1;
  }

  const { comparison, result } = await analyseDrift(store, siteId, current.sweepId, {
    stabilityWindow: windowSize,
    goneAfter,
  });

  console.log(`site        ${siteId}  ${site.url}`);
  console.log(`sweep       ${current.sweepId}  ${current.scannedAt}`);
  console.log(
    `baseline    ${site.approvedBaselineId ?? "(none)"}  compared to: ${comparison.comparedTo}`,
  );
  // the reference snapshot is dropped from the window (it is already the other
  // side of the comparison), so the effective size is usually one less than the
  // number of documents that were loaded
  const effective = prepareWindow(current, comparison.window, comparison.against);
  console.log(
    `window      ${effective.length} of ${comparison.window.length} loaded, N=${windowSize} M=${goneAfter}` +
      `  (${effective.map((fp) => fp.sweepId).join(", ") || "empty"})`,
  );
  console.log(
    `pending     ${(site.pendingDomains ?? []).length} domains, ` +
      `${(site.pendingCookies ?? []).length} cookies` +
      (site.pendingSweepId ? ` (from ${site.pendingSweepId})` : ""),
  );
  console.log();

  if (isIncompatibleResult(result)) {
    console.log(`no comparison: ${result.reason}`);
  } else if (!comparison.against) {
    console.log("no comparison: this is the site's only sweep");
  } else {
    const table = stabilityTable(
      current,
      comparison.against,
      comparison.window,
      comparison.comparedTo,
      {
        goneAfter,
        pendingDomains: site.pendingDomains ?? [],
        pendingCookies: site.pendingCookies ?? [],
      },
    );

    const rows = [...table.hosts]
      .sort(
        (a, b) =>
          CLASS_ORDER.indexOf(a.classification) - CLASS_ORDER.indexOf(b.classification) ||
          a.registrableDomain.localeCompare(b.registrableDomain),
      )
      .map((entry) => ({
        domain: entry.registrableDomain,
        ratio: ratio(entry.presenceRatio, table.windowSize),
        inBaseline: entry.inBaseline,
        classification: entry.classification,
        vendor: entry.vendor ?? "",
      }));
    printDomains(rows);

    const counts = new Map<StabilityClass, number>();
    for (const entry of [...table.hosts, ...table.cookies]) {
      counts.set(entry.classification, (counts.get(entry.classification) ?? 0) + 1);
    }
    console.log();
    console.log(
      `hosts ${table.hosts.length}, cookies ${table.cookies.length} — ` +
        CLASS_ORDER.filter((name) => counts.has(name))
          .map((name) => `${name} ${counts.get(name)}`)
          .join(", "),
    );
    console.log(
      `alerts: ${result.alerts.hostsAdded.length} added, ${result.alerts.hostsRemoved.length} removed, ` +
        `${result.alerts.cookiesAdded.length} cookies added, ${result.alerts.cookiesRemoved.length} cookies removed; ` +
        `noise ${result.noiseCount}`,
    );

    const cookieRows = table.cookies.filter((entry) => entry.classification !== "stable");
    if (cookieRows.length > 0) {
      console.log();
      console.log("cookies that are not stable:");
      for (const entry of cookieRows) {
        console.log(
          `  ${cell(entry.classification, 13)} ${cell(ratio(entry.presenceRatio, table.windowSize), 5, "right")}  ` +
            `${entry.name} @ ${entry.domain}`,
        );
      }
    }
  }

  const decisions = await store.listDecisions(siteId, Math.max(windowSize + 2, 10));
  console.log();
  console.log("decisions, newest first:");
  for (const decision of decisions) {
    console.log(
      `  ${cell(decision.action, 16)} ${decision.at}  noise ${decision.noiseCount ?? "-"}` +
        (decision.hostsAdded?.length ? `  +${decision.hostsAdded.join(",")}` : "") +
        (decision.hostsRemoved?.length ? `  -${decision.hostsRemoved.join(",")}` : ""),
    );
    console.log(`  ${" ".repeat(16)} ${decision.summary}`);
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof NotFoundError) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });
