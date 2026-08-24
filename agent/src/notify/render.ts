/**
 * the two documents a drift finding leaves a human: a GitHub issue and an
 * email.
 *
 * pure functions over the decision and the redline, and deliberately not a
 * third `LlmAgent`. every word worth saying has already been written — the
 * analyst's summary and classifications, the scribe's Czech redline and RoPA
 * row — so a model here would only paraphrase two documents it must not
 * contradict, at the price of another failure mode on the path between finding
 * a tracker and telling somebody about it. what is left is assembly, and
 * assembly should be exactly reproducible.
 */

import type { Decision, Redline, RopaRow, Site } from "../types.js";

/** everything the two renderings are built from */
export interface NotifyContent {
  site: Site;
  decision: Decision;
  redline: Redline;
}

/** a rendered GitHub issue */
export interface RenderedIssue {
  title: string;
  body: string;
}

/** a rendered email */
export interface RenderedEmail {
  subject: string;
  html: string;
}

/**
 * the headline both renderings share: the site and what moved.
 *
 * the domains are in it rather than a generic "drift detected" because these
 * arrive in an inbox and an issue list, where the first line is often the only
 * line anyone reads before deciding whether this is today's problem.
 *
 * @param content the decision and its site
 * @returns a one-line subject
 */
export function headline(content: NotifyContent): string {
  const { site, decision } = content;
  const added = decision.hostsAdded ?? [];
  const removed = decision.hostsRemoved ?? [];

  const parts: string[] = [];
  if (added.length > 0) parts.push(`+${added.join(", +")}`);
  if (removed.length > 0) parts.push(`-${removed.join(", -")}`);

  return parts.length > 0
    ? `${site.siteId}: ${parts.join(" ")}`
    : `${site.siteId}: tracking drift`;
}

/**
 * renders the ticket.
 *
 * the Firestore paths are in the body rather than links: there is no console
 * URL that survives a project rename, and the path is what someone actually
 * types into the console's document lookup.
 *
 * @param content the decision, its redline and the site
 * @returns the issue title and markdown body
 */
export function renderIssue(content: NotifyContent): RenderedIssue {
  const { site, decision, redline } = content;
  const sections: string[] = [];

  sections.push(`**${site.url}** — sweep \`${decision.sweepId}\``);
  sections.push(decision.summary);

  const added = decision.hostsAdded ?? [];
  const removed = decision.hostsRemoved ?? [];
  if (added.length > 0) sections.push(`### Přibylo\n\n${added.map(bullet).join("\n")}`);
  if (removed.length > 0) sections.push(`### Zmizelo\n\n${removed.map(bullet).join("\n")}`);

  if (decision.classifications && decision.classifications.length > 0) {
    const rows = decision.classifications.map(
      (entry) =>
        `| \`${entry.domain}\` | ${entry.vendor ?? "_nezjištěn_"} | ${entry.category} | ${entry.confidence} | ${escapePipes(entry.basis)} |`,
    );
    sections.push(
      [
        "### Klasifikace",
        "",
        "| doména | provozovatel | kategorie | jistota | podklad |",
        "| --- | --- | --- | --- | --- |",
        ...rows,
      ].join("\n"),
    );
  }

  sections.push(`### Úprava cookie lišty a zásad\n\n${redline.policyRedline}`);
  sections.push(`### Záznam o činnostech zpracování\n\n${ropaMarkdown(redline.ropaRow)}`);

  const noise = decision.noiseCount ?? 0;
  sections.push(
    [
      "### Původ",
      "",
      `- rozhodnutí: \`sites/${site.siteId}/decisions/${decision.sweepId}\``,
      `- redline: \`sites/${site.siteId}/redlines/${decision.sweepId}\``,
      `- otisk: \`sites/${site.siteId}/fingerprints/${decision.sweepId}\``,
      `- sweep \`${decision.sweepId}\`, rozhodnuto ${decision.at} (${decision.model})`,
      `- redline zapsán ${redline.at}`,
      `- rotující rozdíly, které stabilizační okno odfiltrovalo: ${noise}`,
    ].join("\n"),
  );

  return { title: headline(content), body: sections.join("\n\n") };
}

/**
 * renders the owner email.
 *
 * inline styles and a table layout free of them: this is read in Gmail, which
 * strips a `<style>` block, and the fallback has to stay legible rather than
 * merely unstyled.
 *
 * @param content the decision, its redline and the site
 * @param issueUrl the ticket this finding filed, when one was filed
 * @returns the subject and HTML body
 */
export function renderEmail(content: NotifyContent, issueUrl: string | null): RenderedEmail {
  const { site, decision, redline } = content;
  const added = decision.hostsAdded ?? [];
  const removed = decision.hostsRemoved ?? [];
  const blocks: string[] = [];

  blocks.push(
    `<p style="margin:0 0 4px"><strong style="font-size:18px">${esc(site.siteId)}</strong></p>`,
    `<p style="margin:0 0 16px;color:#555"><a href="${esc(site.url)}">${esc(site.url)}</a> — sweep <code>${esc(decision.sweepId)}</code></p>`,
    `<p style="margin:0 0 16px">${esc(decision.summary)}</p>`,
  );

  if (added.length > 0) blocks.push(list("Přibylo", added));
  if (removed.length > 0) blocks.push(list("Zmizelo", removed));

  if (decision.classifications && decision.classifications.length > 0) {
    const rows = decision.classifications
      .map(
        (entry) =>
          `<tr><td style="${CELL}"><code>${esc(entry.domain)}</code></td>` +
          `<td style="${CELL}">${esc(entry.vendor ?? "nezjištěn")}</td>` +
          `<td style="${CELL}">${esc(entry.category)}</td>` +
          `<td style="${CELL}">${esc(entry.confidence)}</td>` +
          `<td style="${CELL}">${esc(entry.basis)}</td></tr>`,
      )
      .join("");
    blocks.push(
      heading("Klasifikace"),
      `<table style="border-collapse:collapse;width:100%;font-size:14px">` +
        `<tr><th style="${CELL};text-align:left">doména</th><th style="${CELL};text-align:left">provozovatel</th>` +
        `<th style="${CELL};text-align:left">kategorie</th><th style="${CELL};text-align:left">jistota</th>` +
        `<th style="${CELL};text-align:left">podklad</th></tr>${rows}</table>`,
    );
  }

  blocks.push(
    heading("Úprava cookie lišty a zásad"),
    `<div style="${PANEL}">${paragraphs(redline.policyRedline)}</div>`,
    heading("Záznam o činnostech zpracování"),
    `<table style="border-collapse:collapse;width:100%;font-size:14px">${ropaRows(redline.ropaRow)}</table>`,
  );

  if (issueUrl) {
    blocks.push(
      `<p style="margin:24px 0 0"><a href="${esc(issueUrl)}" style="background:#1f6feb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">Otevřít ticket</a></p>`,
    );
  }

  blocks.push(
    `<p style="margin:24px 0 0;color:#777;font-size:12px">Pixel Patrol — rozhodnutí <code>sites/${esc(site.siteId)}/decisions/${esc(decision.sweepId)}</code>, redline <code>sites/${esc(site.siteId)}/redlines/${esc(decision.sweepId)}</code>. Rozhodnuto ${esc(decision.at)} modelem ${esc(decision.model)}.</p>`,
  );

  return {
    subject: `Pixel Patrol: ${headline(content)}`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:680px">${blocks.join("")}</div>`,
  };
}

// ---------------------------------------------------------------------------
// pieces
// ---------------------------------------------------------------------------

/** border and padding shared by every table cell */
const CELL = "border:1px solid #ddd;padding:6px 8px;vertical-align:top";

/** the tinted block the Czech redline sits in */
const PANEL = "background:#f6f8fa;border-left:3px solid #1f6feb;padding:12px 16px;white-space:normal";

/** the RoPA field labels, in the order the toolkit's export prints them */
const ROPA_LABELS: Array<[keyof RopaRow, string]> = [
  ["name", "Název"],
  ["purpose", "Účel"],
  ["legal_basis", "Právní základ"],
  ["data_categories", "Kategorie údajů"],
  ["data_subject_categories", "Subjekty údajů"],
  ["recipients", "Příjemci"],
  ["retention_period", "Doba uložení"],
  ["third_country_transfers", "Třetí země"],
  ["is_dpia_required", "DPIA"],
  ["notes", "Poznámky"],
];

/** one RoPA value as text, whatever its field type is */
function ropaValue(row: RopaRow, key: keyof RopaRow): string {
  const value = row[key];
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "ano" : "ne";
  return String(value);
}

/** the RoPA row as a markdown definition list */
function ropaMarkdown(row: RopaRow): string {
  return ROPA_LABELS.map(([key, label]) => `- **${label}:** ${ropaValue(row, key)}`).join("\n");
}

/** the RoPA row as email table rows */
function ropaRows(row: RopaRow): string {
  return ROPA_LABELS.map(
    ([key, label]) =>
      `<tr><th style="${CELL};text-align:left;width:180px;background:#f6f8fa">${esc(label)}</th>` +
      `<td style="${CELL}">${esc(ropaValue(row, key))}</td></tr>`,
  ).join("");
}

/** a markdown bullet holding a domain */
function bullet(domain: string): string {
  return `- \`${domain}\``;
}

/** a table cell's contents cannot carry an unescaped pipe */
function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|");
}

/** an email section heading */
function heading(text: string): string {
  return `<h3 style="margin:24px 0 8px;font-size:15px">${esc(text)}</h3>`;
}

/** an email bullet list of domains */
function list(label: string, domains: string[]): string {
  const items = domains.map((d) => `<li><code>${esc(d)}</code></li>`).join("");
  return `${heading(label)}<ul style="margin:0;padding-left:20px">${items}</ul>`;
}

/** the redline's own line breaks, kept as paragraphs rather than collapsed */
function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 10px">${esc(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** HTML-escapes model-written text before it is pasted into an email body */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
