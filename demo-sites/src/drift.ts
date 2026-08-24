/**
 * the drift switches.
 *
 * every demo page carries its tracker changes inline, wrapped in a marker pair,
 * and a change is made by commenting that block in or out. that is deliberately
 * the crudest possible mechanism: the demo's whole claim is "a marketer edited
 * the page and the watchdog noticed", so what happens between the edit and the
 * alert has to be nothing but a redeploy of a static file. a page that fetched
 * its tracker list from a config service would be a different, weaker claim.
 *
 * the block looks like this in the HTML, with the payload on its own lines:
 *
 *     <!-- drift:boutique-pixel:start -->
 *     <!--
 *     <script ...></script>
 *     -->
 *     <!-- drift:boutique-pixel:end -->
 *
 * "on" removes the inner comment wrapper, "off" puts it back. the markers
 * themselves never move, so a block can be toggled any number of times and the
 * file returns to exactly the bytes it started with — which matters, because the
 * runbook resets these between takes and a drifting reset is a demo that stops
 * reproducing.
 */

// ---------------------------------------------------------------------------
// the switches
// ---------------------------------------------------------------------------

/** whether a block's payload is live in the page */
export type BlockState = "on" | "off";

/** one switch: where it lives, and which way round the interesting change is */
export interface DriftBlock {
  /** the marker name, unique across every page */
  name: string;
  /** the page file it lives in, relative to `public/` */
  page: string;
  /** the site id the page is registered under */
  siteId: string;
  /** the state the page sits in between demos */
  baseline: BlockState;
  /** what the watchdog is expected to report once the block is flipped */
  expect: string;
}

/**
 * the four switches, one per drift shape. the fifth demo site (`demo-atelier`)
 * has no switch on purpose: it is the control that proves a busy page with
 * several real trackers produces no alert when nobody touches it, and a switch
 * on it would be a switch somebody eventually flips by accident.
 */
export const DRIFT_BLOCKS: readonly DriftBlock[] = [
  {
    name: "boutique-pixel",
    page: "boutique/index.html",
    siteId: "demo-boutique",
    baseline: "off",
    expect: "drift — facebook.net appears on a page that loaded no tracker at all",
  },
  {
    name: "magazine-clarity",
    page: "magazine/index.html",
    siteId: "demo-magazine",
    baseline: "on",
    expect: "drift — clarity.ms disappears from the approved baseline",
  },
  {
    name: "clinic-beacon",
    page: "clinic/index.html",
    siteId: "demo-clinic",
    baseline: "off",
    expect: "drift — toplist.cz appears, and the vendor tables have never heard of it",
  },
  {
    name: "bistro-cookie",
    page: "bistro/index.html",
    siteId: "demo-bistro",
    baseline: "off",
    expect: "drift — a new first-party cookie, with the domain set unchanged",
  },
];

/**
 * looks a switch up by name.
 *
 * @param name the marker name
 * @returns the block, or null when nothing is registered under that name
 */
export function findBlock(name: string): DriftBlock | null {
  return DRIFT_BLOCKS.find((block) => block.name === name) ?? null;
}

/** the state a block sits in when nobody is running a demo */
export function baselineState(block: DriftBlock): BlockState {
  return block.baseline;
}

/** the state that makes a block produce the drift it exists to produce */
export function driftedState(block: DriftBlock): BlockState {
  return block.baseline === "on" ? "off" : "on";
}

// ---------------------------------------------------------------------------
// the toggle
// ---------------------------------------------------------------------------

/** a block name that is not in the file, or is in it more than once */
export class BlockError extends Error {}

/** the markers around one block's payload */
function markers(name: string): { start: string; end: string } {
  return { start: `<!-- drift:${name}:start -->`, end: `<!-- drift:${name}:end -->` };
}

/**
 * finds the payload between a block's markers.
 *
 * both markers must appear exactly once and in order. an HTML file that lost a
 * marker to a careless edit would otherwise be silently left alone, and a demo
 * whose switch does nothing looks exactly like a watchdog that missed the
 * change — the one failure this project cannot afford to stage.
 *
 * @param html the page source
 * @param name the marker name
 * @returns the payload's bounds within `html`
 */
function locate(html: string, name: string): { from: number; to: number } {
  const { start, end } = markers(name);
  const firstStart = html.indexOf(start);
  const firstEnd = html.indexOf(end);
  if (firstStart === -1 || firstEnd === -1) {
    throw new BlockError(`no drift block "${name}" in the page`);
  }
  if (html.indexOf(start, firstStart + 1) !== -1 || html.indexOf(end, firstEnd + 1) !== -1) {
    throw new BlockError(`drift block "${name}" appears more than once in the page`);
  }
  if (firstEnd < firstStart) {
    throw new BlockError(`drift block "${name}" has its end marker before its start marker`);
  }
  return { from: firstStart + start.length, to: firstEnd };
}

/** the payload as it sits between the markers, comment wrapper and all */
export function readBlock(html: string, name: string): string {
  const { from, to } = locate(html, name);
  return html.slice(from, to);
}

/**
 * whether a block's payload is currently live.
 *
 * "wrapped in a comment" is the whole test, and it is written against the exact
 * wrapper {@link setBlockState} writes rather than against HTML comments in
 * general: the payloads contain comments of their own.
 *
 * @param html the page source
 * @param name the marker name
 * @returns the block's state
 */
export function blockState(html: string, name: string): BlockState {
  const payload = readBlock(html, name).trim();
  return payload.startsWith("<!--") && payload.endsWith("-->") ? "off" : "on";
}

/**
 * comments a block's payload in or out.
 *
 * a no-op when the block is already in the requested state, so a reset over a
 * clean checkout rewrites nothing and `git status` stays a usable signal of what
 * a demo run actually changed.
 *
 * @param html the page source
 * @param name the marker name
 * @param state the state to leave the block in
 * @returns the page source, and whether it changed
 */
export function setBlockState(
  html: string,
  name: string,
  state: BlockState,
): { html: string; changed: boolean } {
  if (blockState(html, name) === state) return { html, changed: false };

  const { from, to } = locate(html, name);
  const payload = html.slice(from, to);
  const inner = state === "off" ? `\n<!--${payload}-->\n` : uncomment(payload);

  return { html: `${html.slice(0, from)}${inner}${html.slice(to)}`, changed: true };
}

/**
 * strips the comment wrapper {@link setBlockState} added, and the newlines it
 * padded it with, so an on/off/on round trip is byte-identical to the original.
 */
function uncomment(payload: string): string {
  const open = payload.indexOf("<!--");
  const close = payload.lastIndexOf("-->");
  if (open === -1 || close === -1 || close < open) {
    throw new BlockError("the payload is not wrapped in a comment");
  }
  return payload.slice(open + "<!--".length, close);
}
