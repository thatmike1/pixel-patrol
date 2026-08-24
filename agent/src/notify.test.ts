/**
 * tests for the step that leaves the system: the ticket and the owner email.
 *
 * mocked at the fetch boundary rather than at the client functions, because the
 * things worth pinning down here are the request bodies — that the Czech
 * redline actually reaches GitHub, that Resend is addressed at the one
 * deliverable recipient — and a stubbed `fileIssue` would assert nothing about
 * either.
 *
 * the load-bearing case is the last group. a Pub/Sub redelivery re-runs this
 * whole path, and two tickets for one finding is the failure that makes an
 * owner stop reading them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import pino from "pino";

import type { NotifyConfig } from "./config.js";
import type { Store } from "./firestore.js";
import { notifyDrift } from "./notifier.js";
import { renderEmail, renderIssue } from "./notify/render.js";
import { runNotifierIfDrift } from "./server.js";
import { fakeStore } from "./test-support.js";
import type { Decision, Redline, RopaRow } from "./types.js";

/** silent logger — these tests assert on return values, not on log output */
const log = pino({ level: "silent" });

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** one recorded HTTP call, kept for assertions */
interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** what a stub decides to answer with */
interface Reply {
  status: number;
  body: unknown;
}

/**
 * a fetch that records every call and answers from a routing function.
 *
 * @param route decides the reply from the request URL and the call index
 * @returns the fetch to inject and the log of calls it saw
 */
function stubFetch(route: (url: string, index: number) => Reply): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>, headers });
    const reply = route(url, calls.length - 1);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** both credentials present, addressed at the throwaway ticket repo */
function notifyConfig(overrides: Partial<NotifyConfig> = {}): NotifyConfig {
  return {
    githubToken: "ghp-test",
    githubRepo: "thatmike1/pixel-patrol-tickets",
    resendApiKey: "re-test",
    resendFrom: "Pixel Patrol <onboarding@resend.dev>",
    defaultOwnerEmail: "thatmike.dev@gmail.com",
    ...overrides,
  };
}

/** the RoPA row the scribe produced */
function ropaRow(): RopaRow {
  return {
    name: "Měření návštěvnosti webu example.test",
    purpose: "Sledování chování návštěvníků",
    legal_basis: "Souhlas (čl. 6 odst. 1 písm. a) GDPR)",
    data_categories: ["Identifikátory v cookies", "IP adresa"],
    data_subject_categories: ["Návštěvníci webu"],
    recipients: ["Google"],
    retention_period: "2 roky",
    third_country_transfers: "Ano — USA",
    is_dpia_required: false,
    notes: "Doména byla nalezena v tabulce trackerů.",
  };
}

/** the verdict the analyst recorded */
function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    siteId: "smoke",
    sweepId: "now",
    action: "drift",
    summary: "Objevila se nová sledovací doména doubleclick.net.",
    hostsAdded: ["doubleclick.net"],
    noiseCount: 3,
    classifications: [
      {
        domain: "doubleclick.net",
        vendor: "Google Marketing Platform",
        category: "advertising",
        confidence: "high",
        basis: "exact entry in the tracker table",
      },
    ],
    at: "2026-08-24T10:00:00.000Z",
    model: "gemini-test",
    ...overrides,
  };
}

/** the paperwork the scribe produced */
function redline(overrides: Partial<Redline> = {}): Redline {
  return {
    siteId: "smoke",
    sweepId: "now",
    policyRedline:
      "Přidat: doména doubleclick.net, provozovatel Google Marketing Platform, reklamní cookies.",
    ropaRow: ropaRow(),
    domains: ["doubleclick.net"],
    at: "2026-08-24T10:00:05.000Z",
    model: "gemini-test",
    ...overrides,
  };
}

/** a site with a drift decision and its redline already written */
async function driftedSite(ownerEmail?: string): Promise<{
  store: Store;
  recorded: ReturnType<typeof fakeStore>["recorded"];
}> {
  const { store, recorded } = fakeStore(
    {
      siteId: "smoke",
      url: "https://example.test",
      ...(ownerEmail ? { ownerEmail } : {}),
    },
    [],
  );
  await store.writeDecision(decision());
  await store.writeRedline(redline());
  return { store, recorded };
}

/** GitHub accepts, Resend accepts */
const happy = (url: string): Reply =>
  url.includes("api.github.com")
    ? { status: 201, body: { number: 7, html_url: "https://github.com/thatmike1/pixel-patrol-tickets/issues/7" } }
    : { status: 200, body: { id: "email-abc" } };

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

test("a drift with a redline files a ticket and mails the owner", async () => {
  const { store, recorded } = await driftedSite();
  const { fetchImpl, calls } = stubFetch(happy);

  const outcome = await notifyDrift({ store, log, config: notifyConfig(), fetchImpl }, decision());

  assert.equal(outcome.notified, true);
  assert.equal(calls.length, 2);

  const issue = calls[0];
  assert.equal(issue?.url, "https://api.github.com/repos/thatmike1/pixel-patrol-tickets/issues");
  assert.match(String(issue?.body.title), /doubleclick\.net/);
  // the Czech redline is the point of the ticket, not a link to it
  assert.match(String(issue?.body.body), /Přidat: doména doubleclick\.net/);
  assert.match(String(issue?.body.body), /Souhlas \(čl\. 6/);
  assert.match(String(issue?.body.body), /sites\/smoke\/decisions\/now/);
  assert.equal(issue?.headers.authorization, "Bearer ghp-test");

  const email = calls[1];
  assert.equal(email?.url, "https://api.resend.com/emails");
  // the account's domain is unverified, so this is the only address that lands
  assert.deepEqual(email?.body.to, ["thatmike.dev@gmail.com"]);
  assert.equal(email?.body.from, "Pixel Patrol <onboarding@resend.dev>");
  assert.match(String(email?.body.html), /Přidat: doména doubleclick\.net/);
  // the ticket is linked from the mail, which means it has to be filed first
  assert.match(String(email?.body.html), /issues\/7/);

  const stored = recorded.notifications[0];
  assert.equal(stored?.issue?.number, 7);
  assert.equal(stored?.email?.id, "email-abc");
  assert.equal(stored?.email?.to, "thatmike.dev@gmail.com");
  assert.deepEqual(stored?.domains, ["doubleclick.net"]);
});

test("a site's own owner address wins over the default", async () => {
  const { store } = await driftedSite("owner@example.test");
  const { fetchImpl, calls } = stubFetch(happy);

  await notifyDrift({ store, log, config: notifyConfig(), fetchImpl }, decision());

  assert.deepEqual(calls[1]?.body.to, ["owner@example.test"]);
});

// ---------------------------------------------------------------------------
// when nothing should be sent
// ---------------------------------------------------------------------------

test("a noop sweep notifies nobody", async () => {
  const { store, recorded } = await driftedSite();
  const { fetchImpl, calls } = stubFetch(happy);

  for (const action of ["noop", "baseline-created", "failed"] as const) {
    const outcome = await notifyDrift(
      { store, log, config: notifyConfig(), fetchImpl },
      decision({ action }),
    );
    assert.equal(outcome.skipped, "not-drift");
  }

  assert.equal(calls.length, 0, "the hourly noop path must not touch GitHub or Resend");
  assert.equal(recorded.notifications.length, 0);
});

test("a drift whose scribe failed is not announced without its redline", async () => {
  // a ticket saying "something changed" with no policy edit in it is the
  // notification this product exists to replace
  const { store } = fakeStore({ siteId: "smoke", url: "https://example.test" }, []);
  await store.writeDecision(decision());
  const { fetchImpl, calls } = stubFetch(happy);

  const outcome = await notifyDrift({ store, log, config: notifyConfig(), fetchImpl }, decision());

  assert.equal(outcome.skipped, "no-redline");
  assert.equal(calls.length, 0);
});

test("a deployment with no credentials skips rather than crashing the sweep", async () => {
  const { store } = await driftedSite();
  const { fetchImpl, calls } = stubFetch(happy);

  const outcome = await notifyDrift(
    {
      store,
      log,
      config: notifyConfig({ githubToken: null, resendApiKey: null }),
      fetchImpl,
    },
    decision(),
  );

  assert.equal(outcome.skipped, "not-configured");
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// redelivery
// ---------------------------------------------------------------------------

test("a redelivered sweep files one ticket and sends one email", async () => {
  const { store, recorded } = await driftedSite();
  const { fetchImpl, calls } = stubFetch(happy);
  const deps = { store, log, config: notifyConfig(), fetchImpl };

  await notifyDrift(deps, decision());
  const second = await notifyDrift(deps, decision());

  assert.equal(second.skipped, "already-notified");
  assert.equal(calls.length, 2, "one issue, one email, across both deliveries");
  assert.equal(recorded.notifications.length, 1);
});

test("a replay after a half failure sends only the missing half", async () => {
  const { store, recorded } = await driftedSite();
  // first pass: GitHub takes it, Resend is down
  const first = stubFetch((url) =>
    url.includes("api.github.com")
      ? happy(url)
      : { status: 500, body: { message: "resend is having a day" } },
  );
  const deps = { store, log, config: notifyConfig() };

  const one = await notifyDrift({ ...deps, fetchImpl: first.fetchImpl }, decision());
  assert.equal(one.notified, true, "the ticket landed, so something was notified");
  assert.equal(recorded.notifications[0]?.issue?.number, 7);
  assert.equal(recorded.notifications[0]?.email, null);
  assert.match(String(recorded.notifications[0]?.emailError), /500/);

  const second = stubFetch(happy);
  const two = await notifyDrift({ ...deps, fetchImpl: second.fetchImpl }, decision());

  assert.equal(two.notified, true);
  assert.equal(second.calls.length, 1, "the ticket is not filed twice to get the mail out");
  assert.equal(second.calls[0]?.url, "https://api.resend.com/emails");
  assert.equal(recorded.notifications.length, 1);
  const finished = recorded.notifications[0];
  assert.equal(finished?.issue?.number, 7);
  assert.equal(finished?.email?.id, "email-abc");
  assert.equal(finished?.emailError, undefined, "the resolved failure is not carried forward");
});

test("a mail that cannot be sent leaves the decision and the redline standing", async () => {
  const { store, recorded } = await driftedSite();
  const { fetchImpl } = stubFetch(() => ({ status: 502, body: { message: "bad gateway" } }));

  const outcome = await notifyDrift({ store, log, config: notifyConfig(), fetchImpl }, decision());

  assert.equal(outcome.notified, false);
  assert.equal(recorded.decisions.length, 1);
  assert.equal(recorded.redlines.length, 1);
  assert.match(String(recorded.notifications[0]?.issueError), /502/);
});

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

test("a notifier that throws does not fail the delivery", async () => {
  // a non-2xx here would send the whole sweep back through Pub/Sub and re-run
  // the analyst and the scribe to retry an HTTP call
  const outcome = await runNotifierIfDrift(
    {
      log,
      notify: async () => {
        throw new Error("firestore unavailable");
      },
    },
    decision(),
  );

  assert.equal(outcome.notified, false);
  assert.equal(outcome.error, "firestore unavailable");
});

test("the notifier is not called at all on a noop", async () => {
  let calls = 0;
  const outcome = await runNotifierIfDrift(
    {
      log,
      notify: async () => {
        calls += 1;
        return { notified: false };
      },
    },
    decision({ action: "noop" }),
  );

  assert.equal(outcome.skipped, "not-drift");
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test("the headline names the site and what moved", () => {
  const content = {
    site: { siteId: "demo-shop", url: "https://example.test" },
    decision: decision({ hostsRemoved: ["hotjar.com"] }),
    redline: redline(),
  };

  const issue = renderIssue(content);
  assert.equal(issue.title, "demo-shop: +doubleclick.net -hotjar.com");
  assert.match(issue.body, /### Klasifikace/);
  assert.match(issue.body, /Google Marketing Platform/);
  // the boolean and the arrays have to survive into readable Czech
  assert.match(issue.body, /\*\*DPIA:\*\* ne/);
  assert.match(issue.body, /Identifikátory v cookies, IP adresa/);
});

test("model-written text cannot inject markup into the email", () => {
  const content = {
    site: { siteId: "smoke", url: "https://example.test" },
    decision: decision({ summary: "<script>alert(1)</script> a tag appeared" }),
    redline: redline(),
  };

  const email = renderEmail(content, null);
  assert.equal(email.html.includes("<script>"), false);
  assert.match(email.html, /&lt;script&gt;/);
});
