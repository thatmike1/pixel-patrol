/**
 * the drift analyst: one LlmAgent, five tools, one decision per sweep.
 *
 * the division of labour is the whole design. the tools do everything that must
 * be exactly right — reading fingerprints, computing the set difference, writing
 * the verdict — and the model does the part that needs judgement: whether a
 * difference is the site's first sweep, harmless churn, or a tracker that
 * appeared without anyone deciding to add it, and how to say so to the person
 * who will have to answer for it.
 */

import { getFunctionCalls, InMemorySessionService, LlmAgent, Runner } from "@google/adk";
import type { Event } from "@google/adk";

import { DEFAULT_GONE_AFTER, DEFAULT_STABILITY_WINDOW } from "@pixel-patrol/shared";

import type { DriftOptions } from "./drift.js";
import { createStore } from "./firestore.js";
import type { Store } from "./firestore.js";
import { createTools } from "./tools/index.js";

/** the ADK app name, used to scope sessions */
const APP_NAME = "pixel-patrol";

/** the user id every autonomous run acts as — there is no human in this loop */
const SYSTEM_USER = "pixel-patrol-system";

/**
 * the analyst's standing orders.
 *
 * written as a procedure rather than a persona: this agent runs unattended
 * behind a Pub/Sub push, so every branch it can hit has to be spelled out. the
 * ban on inventing hosts matters more than it looks — a hallucinated tracker in
 * a compliance report is worse than a missed one, because someone will act on it.
 */
export const ANALYST_INSTRUCTION = `You are Pixel Patrol's drift analyst. A sweep of one website has just finished. Decide whether the site's third-party tracking changed, and record exactly one decision.

Procedure:
1. Call get_sweep_context.
2. If baseline is null AND previous is null, this is the site's first sweep. Call approve_baseline, then call record_decision with action "baseline-created" and a summary giving the host and cookie counts. Stop.
3. Otherwise call diff_against_baseline.
   - If comparedTo is "incompatible", the two sweeps were recorded in different fingerprint formats and cannot be compared. Call approve_baseline, then call record_decision with action "baseline-created" and a summary saying the scanner's data format changed so a fresh baseline was taken. Stop.
   - If hostsAdded, hostsRemoved, cookiesAdded and cookiesRemoved inside "alerts" are all empty, call record_decision with action "noop", noiseCount set to the tool's noiseCount, and a one-line summary saying the site is unchanged since the sweep named in comparedTo. When noiseCount is above zero you may add one clause of the form "N rotating ad-tech domains ignored".
   - Otherwise this is drift. Before recording it, call lookup_host_knowledge once for every entry in alerts.hostsAdded, passing its registrableDomain and exampleHost, and the names from alerts.cookiesAdded as cookieNames. Then call record_decision with action "drift", passing the registrableDomain values from alerts.hostsAdded and alerts.hostsRemoved, noiseCount from the tool, one classifications entry per added domain, and a summary that names every domain and cookie in "alerts", quotes the example host for each domain, and says what the added ones are for and which consent category they fall in.

Classifying an added domain:
- vendor is the vendor from "exact" when the lookup returned one. Otherwise it is the vendor shared by the entries in "related", and only if they agree. Otherwise it is null.
- category must be one of the strings in "categories".
- confidence is "high" when "exact" answered, "medium" when only "related" did, and "low" when your only support is "heuristic" or you have none.
- basis must name what the lookup actually returned: the matching table entry, the related domains and the token they share, or the regex in heuristic.matchedRule. If every tier came back empty, record category "unclassified", vendor null, confidence "low", and a basis saying the tables and the heuristics have no entry for this domain.
- A domain you cannot identify is a normal outcome and the correct answer. Never name a company the lookup did not give you, and never soften "unclassified" into a guess because the summary would read better.

Rules:
- Nothing under "noise" is drift, ever. "flapping" is ad-tech and A/B rotation the site does to itself, "missingOnce" is a single sweep that failed to see something, and "pending" was already reported and is waiting for a human decision. Never move an entry out of noise, never name one as a tracker that appeared, and never record "drift" when every list under "alerts" is empty.
- Only ever state domains, hosts, cookies, counts and scores that a tool returned. Never guess a vendor you were not told.
- "related" entries are a lead, never an identification: a domain that merely shares a brand token with a known vendor is at most "medium" confidence and the basis must say the match was by name.
- Call record_decision exactly once, and make it your last tool call.
- Write the summary for a site owner who is not technical and who may have to defend it to a regulator.
- Finish with one sentence stating the action you recorded and why. No preamble, no questions, no offers of further help.`;

/** what one analyst run produced */
export interface AnalysisResult {
  /** the model's closing sentence, empty when it ended on a tool call */
  finalText: string;
  /** the tools it called, in order, for the log */
  toolCalls: string[];
}

/**
 * builds the analyst agent.
 *
 * @param store the Firestore accessors the tools read and write through
 * @param model the Gemini model id
 * @param options the stability window rules the drift tools share
 * @returns the configured agent
 */
export function buildAnalystAgent(
  store: Store,
  model: string,
  options: DriftOptions,
): LlmAgent {
  return new LlmAgent({
    name: "drift_analyst",
    model,
    description: "Decides whether a completed site sweep shows tracking drift, and records it.",
    instruction: ANALYST_INSTRUCTION,
    tools: createTools(store, model, options),
  });
}

/**
 * builds a runner for the analyst.
 *
 * sessions are in-memory on purpose: a run is one sweep, start to verdict, and
 * nothing about it should carry into the next one. the durable record is the
 * decision document, not a conversation.
 *
 * @param store the Firestore accessors
 * @param model the Gemini model id
 * @param options the stability window rules
 * @returns a runner ready to accept sweeps
 */
export function createAnalystRunner(store: Store, model: string, options: DriftOptions): Runner {
  return new Runner({
    appName: APP_NAME,
    agent: buildAnalystAgent(store, model, options),
    sessionService: new InMemorySessionService(),
  });
}

/**
 * runs the analyst over one finished sweep and drains its event stream.
 *
 * @param runner the analyst runner
 * @param input the sweep to analyse
 * @returns the model's closing sentence and the tools it called
 */
export async function analyseSweep(
  runner: Runner,
  input: { siteId: string; sweepId: string },
): Promise<AnalysisResult> {
  const session = await runner.sessionService.createSession({
    appName: APP_NAME,
    userId: SYSTEM_USER,
  });

  const toolCalls: string[] = [];
  let finalText = "";

  for await (const event of runner.runAsync({
    userId: SYSTEM_USER,
    sessionId: session.id,
    newMessage: {
      parts: [
        {
          text: `Sweep ${input.sweepId} finished for site ${input.siteId}. Decide whether anything changed and record your decision.`,
        },
      ],
    },
  })) {
    for (const call of getFunctionCalls(event)) {
      if (call.name) toolCalls.push(call.name);
    }
    const text = textOf(event);
    if (text) finalText = text;
  }

  return { finalText, toolCalls };
}

/** the plain text parts of an event, joined; empty when it carried none */
function textOf(event: Event): string {
  const parts = event.content?.parts ?? [];
  return parts
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

/**
 * the agent as a bare object, for `adk web` and the ADK dev tools.
 *
 * the service itself does not use this — it builds its own through
 * `createAnalystRunner` with the validated config. this export exists so the
 * same agent can be opened in the ADK inspector against the same Firestore.
 */
export const rootAgent: LlmAgent = buildAnalystAgent(
  createStore(process.env.GOOGLE_CLOUD_PROJECT ?? ""),
  process.env.MODEL?.trim() || "gemini-3.5-flash",
  { stabilityWindow: DEFAULT_STABILITY_WINDOW, goneAfter: DEFAULT_GONE_AFTER },
);
