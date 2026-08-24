/**
 * tests for retiring a site.
 *
 * a disabled site is the difference between a watchdog you can point at a
 * throwaway target and one that keeps crawling somebody else's domain every
 * hour forever because deregistering would have thrown the findings away. the
 * two things worth asserting are that the tick skips it, and that a site
 * registered before the flag existed is not skipped by accident.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import pino from "pino";

import type { AgentConfig } from "./config.js";
import { createApp } from "./server.js";
import type { AppDeps } from "./server.js";
import { fakeStore } from "./test-support.js";
import type { Site } from "./types.js";

const log = pino({ level: "silent" });
const SELF_URL = "https://patrol-agent.test";
const ADMIN_KEY = "test-admin-key";

/** a config with the model and the notifier switched off */
function config(): AgentConfig {
  return {
    projectId: "pixel-patrol-test",
    geminiLocation: "global",
    model: "gemini-test",
    region: "europe-west1",
    crawlerJob: "patrol-crawler",
    stabilityWindow: 5,
    goneAfter: 3,
    siteSweepTopic: "site-sweep",
    adminKey: ADMIN_KEY,
    notify: {
      githubToken: null,
      githubRepo: "thatmike1/pixel-patrol-tickets",
      resendApiKey: null,
      resendFrom: "Pixel Patrol <patrol@ssscribe.app>",
      defaultOwnerEmail: "thatmike.dev@gmail.com",
    },
    selfUrl: SELF_URL,
    port: 0,
    logLevel: "silent",
  };
}

/** an empty push envelope, for the tick */
const TICK = {
  message: { messageId: "1", data: Buffer.from("{}", "utf-8").toString("base64") },
  subscription: "projects/pixel-patrol-test/subscriptions/sweep-tick-push",
};

/** starts the app over one site and returns a POST helper plus what was published */
async function serve(site: Site): Promise<{
  post: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
  unauthenticated: (path: string, body: unknown) => Promise<{ status: number }>;
  published: string[];
}> {
  const { store } = fakeStore(site, []);
  const published: string[] = [];
  const deps: AppDeps = {
    config: config(),
    log,
    store,
    publisher: {
      async publishSiteSweep(message) {
        published.push(message.siteId);
        return "message-1";
      },
    },
    jobs: { async runCrawl() { return { execution: "exec-1", operation: "op-1" }; } },
    verifier: { async verify() { return { email: "patrol-agent@pixel-patrol-test.iam.gserviceaccount.com" }; } },
    async analyse() { return { finalText: "", toolCalls: [] }; },
    async scribe() { return { finalText: "", toolCalls: [] }; },
    async notify() { return { notified: false }; },
  };

  const server = createApp(deps).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  after(() => server.close());

  const call = async (
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  return {
    published,
    post: (path, body) =>
      call(path, body, { authorization: "Bearer fake", "x-admin-key": ADMIN_KEY }),
    unauthenticated: (path, body) => call(path, body, { authorization: "Bearer fake" }),
  };
}

test("a site with no enabled flag is still swept", async () => {
  // every site registered before the flag existed has no `enabled` at all
  const { post, published } = await serve({ siteId: "smoke", url: "https://example.test" });

  assert.equal((await post("/trigger/tick", TICK)).status, 204);
  assert.deepEqual(published, ["smoke"]);
});

test("disabling a site takes it off the schedule", async () => {
  const { post, published } = await serve({ siteId: "demo-shop", url: "https://example.test" });

  const disabled = await post("/sites/demo-shop/enabled", { enabled: false });
  assert.equal(disabled.status, 200);
  assert.deepEqual(disabled.body, { siteId: "demo-shop", enabled: false });

  assert.equal((await post("/trigger/tick", TICK)).status, 204);
  assert.deepEqual(published, [], "a retired site must stop costing crawls");
});

test("a disabled site can be put back on the schedule", async () => {
  const { post, published } = await serve({
    siteId: "demo-shop",
    url: "https://example.test",
    enabled: false,
  });

  assert.equal((await post("/trigger/tick", TICK)).status, 204);
  assert.deepEqual(published, []);

  assert.equal((await post("/sites/demo-shop/enabled", { enabled: true })).status, 200);
  assert.equal((await post("/trigger/tick", TICK)).status, 204);
  assert.deepEqual(published, ["demo-shop"]);
});

test("a forced sweep still works on a disabled site", async () => {
  // the operator asking for one is the decision the flag exists to automate
  // away; refusing it would mean deregistering to re-check a retired site once
  const { post, published } = await serve({
    siteId: "demo-shop",
    url: "https://example.test",
    enabled: false,
  });

  assert.equal((await post("/sites/demo-shop/sweep", {})).status, 202);
  assert.deepEqual(published, ["demo-shop"]);
});

test("disabling an unregistered site is a 404, not a silent success", async () => {
  const { post } = await serve({ siteId: "smoke", url: "https://example.test" });

  assert.equal((await post("/sites/nope/enabled", { enabled: false })).status, 404);
});

test("the enabled flag must be a boolean", async () => {
  const { post } = await serve({ siteId: "smoke", url: "https://example.test" });

  assert.equal((await post("/sites/smoke/enabled", { enabled: "false" })).status, 400);
  assert.equal((await post("/sites/smoke/enabled", {})).status, 400);
});

test("retiring a site needs the admin key", async () => {
  const { post, unauthenticated, published } = await serve({
    siteId: "smoke",
    url: "https://example.test",
  });

  assert.equal((await unauthenticated("/sites/smoke/enabled", { enabled: false })).status, 401);

  // and the refusal really left the site on the schedule
  assert.equal((await post("/trigger/tick", TICK)).status, 204);
  assert.deepEqual(published, ["smoke"]);
});
