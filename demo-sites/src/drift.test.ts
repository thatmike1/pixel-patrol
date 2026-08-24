/**
 * tests for the drift switches.
 *
 * the property that matters is the round trip: the runbook resets these pages
 * between takes, and a reset that does not restore the original bytes gives the
 * next demo a different baseline than the one it was rehearsed against.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BlockError,
  blockState,
  baselineState,
  DRIFT_BLOCKS,
  driftedState,
  findBlock,
  readBlock,
  setBlockState,
} from "./drift.js";

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

/** a page with one live block and one commented-out block */
const PAGE = [
  "<body>",
  "<!-- drift:live-one:start -->",
  '<script src="https://example.test/a.js"></script>',
  "<!-- drift:live-one:end -->",
  "<!-- drift:dark-one:start -->",
  "<!--",
  '<script src="https://example.test/b.js"></script>',
  "-->",
  "<!-- drift:dark-one:end -->",
  "</body>",
].join("\n");

test("reads the state of a live block and a commented one", () => {
  assert.equal(blockState(PAGE, "live-one"), "on");
  assert.equal(blockState(PAGE, "dark-one"), "off");
});

test("turning a block off comments its payload out", () => {
  const { html, changed } = setBlockState(PAGE, "live-one", "off");
  assert.equal(changed, true);
  assert.equal(blockState(html, "live-one"), "off");
  // the payload survives, so turning it back on restores the same script
  assert.match(readBlock(html, "live-one"), /example\.test\/a\.js/);
});

test("turning a block on removes the comment wrapper", () => {
  const { html, changed } = setBlockState(PAGE, "dark-one", "on");
  assert.equal(changed, true);
  assert.equal(blockState(html, "dark-one"), "on");
  assert.match(html, /<script src="https:\/\/example\.test\/b\.js"><\/script>/);
});

test("an off/on round trip restores the file byte for byte", () => {
  const off = setBlockState(PAGE, "live-one", "off").html;
  const back = setBlockState(off, "live-one", "on").html;
  assert.equal(back, PAGE);
});

test("an on/off round trip restores the file byte for byte", () => {
  const on = setBlockState(PAGE, "dark-one", "on").html;
  const back = setBlockState(on, "dark-one", "off").html;
  assert.equal(back, PAGE);
});

test("setting a block to the state it is already in changes nothing", () => {
  const { html, changed } = setBlockState(PAGE, "live-one", "on");
  assert.equal(changed, false);
  assert.equal(html, PAGE);
});

test("only the named block moves", () => {
  const { html } = setBlockState(PAGE, "live-one", "off");
  assert.equal(blockState(html, "dark-one"), "off");
  assert.match(readBlock(html, "dark-one"), /example\.test\/b\.js/);
});

test("a missing marker is an error, not a silent no-op", () => {
  // a switch that quietly does nothing looks exactly like a watchdog that
  // missed the change, which is the one failure a demo must never stage
  assert.throws(() => setBlockState(PAGE, "not-there", "on"), BlockError);
});

test("a duplicated marker is an error", () => {
  const doubled = `${PAGE}\n<!-- drift:live-one:start --><!-- drift:live-one:end -->`;
  assert.throws(() => blockState(doubled, "live-one"), BlockError);
});

test("every registered block is in its page and toggles both ways", () => {
  // deliberately not "is at baseline": a demo run leaves these pages drifted on
  // purpose, and a test that failed mid-demo would be noise. `drift status` is
  // what answers where a page currently stands
  for (const block of DRIFT_BLOCKS) {
    const html = readFileSync(resolve(PUBLIC, block.page), "utf-8");
    assert.equal(findBlock(block.name), block);
    assert.notEqual(driftedState(block), baselineState(block));

    const drifted = setBlockState(html, block.name, driftedState(block)).html;
    assert.equal(blockState(drifted, block.name), driftedState(block));

    const reset = setBlockState(drifted, block.name, baselineState(block)).html;
    assert.equal(blockState(reset, block.name), baselineState(block));

    // and the payload survived the round trip, whichever state the file was in
    assert.ok(readBlock(reset, block.name).trim().length > 0);
  }
});

test("each block belongs to its own page and site", () => {
  assert.equal(new Set(DRIFT_BLOCKS.map((b) => b.name)).size, DRIFT_BLOCKS.length);
  assert.equal(new Set(DRIFT_BLOCKS.map((b) => b.siteId)).size, DRIFT_BLOCKS.length);
  assert.equal(new Set(DRIFT_BLOCKS.map((b) => b.page)).size, DRIFT_BLOCKS.length);
});
