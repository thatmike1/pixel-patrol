/**
 * the demo operator's switchboard.
 *
 *   npm --prefix demo-sites run drift -- status
 *   npm --prefix demo-sites run drift -- reset
 *   npm --prefix demo-sites run drift -- induce boutique-pixel
 *
 * it only edits files. nothing here reaches the watchdog, and nothing here
 * deploys: a change is not live until `infra/deploy-demo-sites.sh` has run, and
 * keeping those two steps separate is what stops a half-edited page going out
 * mid-demo. `docs/demo-runbook.md` is the sequence.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  baselineState,
  blockState,
  DRIFT_BLOCKS,
  driftedState,
  findBlock,
  setBlockState,
} from "../src/drift.js";
import type { BlockState, DriftBlock } from "../src/drift.js";

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

/** reads a block's page */
function pageOf(block: DriftBlock): string {
  return readFileSync(resolve(PUBLIC, block.page), "utf-8");
}

/**
 * writes a block into a state and reports whether the file moved.
 *
 * @param block the switch
 * @param state the state to leave it in
 * @returns whether the page changed on disk
 */
function apply(block: DriftBlock, state: BlockState): boolean {
  const { html, changed } = setBlockState(pageOf(block), block.name, state);
  if (changed) writeFileSync(resolve(PUBLIC, block.page), html);
  return changed;
}

/** prints every switch, its page and where it currently stands */
function status(): void {
  for (const block of DRIFT_BLOCKS) {
    const now = blockState(pageOf(block), block.name);
    const label = now === baselineState(block) ? "baseline" : "DRIFTED";
    process.stdout.write(
      `${block.name.padEnd(18)} ${block.siteId.padEnd(15)} ${now.padEnd(4)} ${label}\n`,
    );
  }
}

const [command, argument] = process.argv.slice(2);

switch (command) {
  case "status":
    status();
    break;

  case "reset": {
    for (const block of DRIFT_BLOCKS) {
      const moved = apply(block, baselineState(block));
      process.stdout.write(`${block.name}: ${moved ? "reset to" : "already at"} baseline\n`);
    }
    break;
  }

  case "induce": {
    const block = argument ? findBlock(argument) : null;
    if (!block) {
      const names = DRIFT_BLOCKS.map((b) => b.name).join(", ");
      process.stderr.write(`usage: drift induce <${names}>\n`);
      process.exit(2);
    }
    const moved = apply(block, driftedState(block));
    process.stdout.write(
      `${block.name}: ${moved ? "switched" : "already switched"}, expect ${block.expect}\n` +
        `deploy it:  PROJECT_ID=pixel-patrol-mp ./infra/deploy-demo-sites.sh\n`,
    );
    break;
  }

  default:
    process.stderr.write("usage: drift <status|reset|induce <block>>\n");
    process.exit(2);
}
