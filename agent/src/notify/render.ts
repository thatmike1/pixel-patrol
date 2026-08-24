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
 *
 * ## two languages, on purpose
 *
 * the frame is English and the deliverables are Czech, and the seam between
 * them is labelled.
 *
 * the redline and the RoPA row are Czech because that is what they are: text a
 * Czech site owner pastes into a public cookie policy, and a row they file with
 * ÚOOÚ. translating them would destroy the artifact — the whole product is that
 * the paperwork arrives finished rather than as a description of paperwork
 * somebody still has to write.
 *
 * everything around them is English because a reader who does not speak Czech
 * has to be able to follow what happened: which site, which domains, what the
 * analyst concluded, and which block is the thing to paste where. an English
 * summary running straight into unlabelled Czech reads as a rendering bug. so
 * every Czech block sits under an English heading that says what it is and what
 * to do with it, and the Czech starts only after that heading.
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
  if (added.length > 0) sections.push(`### Domains added\n\n${added.map(bullet).join("\n")}`);
  if (removed.length > 0) sections.push(`### Domains removed\n\n${removed.map(bullet).join("\n")}`);

  if (decision.classifications && decision.classifications.length > 0) {
    const rows = decision.classifications.map(
      (entry) =>
        `| \`${entry.domain}\` | ${entry.vendor ?? "_not identified_"} | ${entry.category} | ${entry.confidence} | ${escapePipes(entry.basis)} |`,
    );
    sections.push(
      [
        "### Classification",
        "",
        "| domain | vendor | category | confidence | basis |",
        "| --- | --- | --- | --- | --- |",
        ...rows,
      ].join("\n"),
    );
  }

  sections.push(
    `### ${REDLINE_HEADING}\n\n${REDLINE_LEDE}\n\n${redline.policyRedline}`,
    `### ${ROPA_HEADING}\n\n${ROPA_LEDE}\n\n${ropaMarkdown(redline.ropaRow)}`,
  );

  const noise = decision.noiseCount ?? 0;
  sections.push(
    [
      "### Provenance",
      "",
      `- decision: \`sites/${site.siteId}/decisions/${decision.sweepId}\``,
      `- redline: \`sites/${site.siteId}/redlines/${decision.sweepId}\``,
      `- fingerprint: \`sites/${site.siteId}/fingerprints/${decision.sweepId}\``,
      `- sweep \`${decision.sweepId}\`, decided ${decision.at} by ${decision.model}`,
      `- redline written ${redline.at}`,
      `- rotating differences the stability window filtered out: ${noise}`,
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

  if (added.length > 0) blocks.push(list("Domains added", added));
  if (removed.length > 0) blocks.push(list("Domains removed", removed));

  if (decision.classifications && decision.classifications.length > 0) {
    const rows = decision.classifications
      .map(
        (entry) =>
          `<tr><td style="${CELL}"><code>${esc(entry.domain)}</code></td>` +
          `<td style="${CELL}">${esc(entry.vendor ?? "not identified")}</td>` +
          `<td style="${CELL}">${esc(entry.category)}</td>` +
          `<td style="${CELL}">${esc(entry.confidence)}</td>` +
          `<td style="${CELL}">${esc(entry.basis)}</td></tr>`,
      )
      .join("");
    blocks.push(
      heading("Classification"),
      `<table style="border-collapse:collapse;width:100%;font-size:14px">` +
        `<tr><th style="${CELL};text-align:left">domain</th><th style="${CELL};text-align:left">vendor</th>` +
        `<th style="${CELL};text-align:left">category</th><th style="${CELL};text-align:left">confidence</th>` +
        `<th style="${CELL};text-align:left">basis</th></tr>${rows}</table>`,
    );
  }

  blocks.push(
    heading(REDLINE_HEADING),
    lede(REDLINE_LEDE),
    `<div style="${PANEL}">${paragraphs(redline.policyRedline)}</div>`,
    heading(ROPA_HEADING),
    lede(ROPA_LEDE),
    `<table style="border-collapse:collapse;width:100%;font-size:14px">${ropaRows(redline.ropaRow)}</table>`,
  );

  if (issueUrl) {
    blocks.push(
      `<p style="margin:24px 0 0"><a href="${esc(issueUrl)}" style="background:#1f6feb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">Open ticket</a></p>`,
    );
  }

  blocks.push(
    `<p style="margin:24px 0 0;color:#777;font-size:12px">Pixel Patrol — decision <code>sites/${esc(site.siteId)}/decisions/${esc(decision.sweepId)}</code>, redline <code>sites/${esc(site.siteId)}/redlines/${esc(decision.sweepId)}</code>. Decided ${esc(decision.at)} by ${esc(decision.model)}.</p>`,
  );

  return {
    subject: `Pixel Patrol: ${headline(content)}`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:680px">${blocks.join("")}</div>`,
  };
}

// ---------------------------------------------------------------------------
// pieces
// ---------------------------------------------------------------------------

/**
 * the English headings the two Czech deliverables sit under, and the one line
 * each that says what to do with it.
 *
 * shared between the issue and the email so the two never drift into describing
 * the same block differently. each names the language explicitly: a reader
 * scrolling past should know the Czech is the deliverable and not a rendering
 * accident before they reach the first Czech word.
 */
const REDLINE_HEADING = "Cookie policy redline (Czech — ready to paste)";
const REDLINE_LEDE =
  "Edit instructions for the site's public cookie policy, written for the Czech site owner to paste and adjust.";
const ROPA_HEADING = "RoPA row (Czech)";
const ROPA_LEDE =
  "One record-of-processing-activities row for this tracking, in the field shape a Czech supervisory authority (ÚOOÚ) expects.";

/** border and padding shared by every table cell */
const CELL = "border:1px solid #ddd;padding:6px 8px;vertical-align:top";

/** the tinted block the Czech redline sits in */
const PANEL = "background:#f6f8fa;border-left:3px solid #1f6feb;padding:12px 16px;white-space:normal";

/**
 * the RoPA field labels, in the order the toolkit's export prints them.
 *
 * English, matching the toolkit's own field keys (`legal_basis`,
 * `third_country_transfers`). the values stay Czech because they are the filed
 * document; the labels are the frame, and a Czech label over a Czech value
 * leaves a non-Czech reader with a table they cannot enter at any point.
 */
const ROPA_LABELS: Array<[keyof RopaRow, string]> = [
  ["name", "Name"],
  ["purpose", "Purpose"],
  ["legal_basis", "Legal basis"],
  ["data_categories", "Data categories"],
  ["data_subject_categories", "Data subject categories"],
  ["recipients", "Recipients"],
  ["retention_period", "Retention period"],
  ["third_country_transfers", "Third country transfers"],
  ["is_dpia_required", "DPIA required"],
  ["notes", "Notes"],
];

/** one RoPA value as text, whatever its field type is */
function ropaValue(row: RopaRow, key: keyof RopaRow): string {
  const value = row[key];
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "yes" : "no";
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

/** the English line under a heading that frames the Czech block below it */
function lede(text: string): string {
  return `<p style="margin:0 0 10px;color:#555;font-size:13px">${esc(text)}</p>`;
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
