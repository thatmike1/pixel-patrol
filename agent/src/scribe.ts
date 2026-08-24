/**
 * the compliance scribe: the second agent, and the one that turns a finding
 * into work someone can actually do.
 *
 * a drift decision on its own is a notification — "gtm.example.com appeared" —
 * and a site owner who receives it still has to work out what to change in
 * their cookie policy and what to write in their records of processing. that is
 * the step that never happens, and it is the step this agent does: an edit to
 * paste and a RoPA row to file, in Czech, naming the tracker the sweep found.
 *
 * it is a separate agent from the analyst rather than four more instructions on
 * that one, for two reasons. it only ever runs on drift, so the noop path — the
 * one that runs every hour on every site — does not pay for a prompt about
 * document drafting. and its rules pull the opposite way: the analyst is
 * writing one careful sentence for a log, the scribe is writing a page of
 * regulated prose. one instruction covering both is one instruction that
 * hedges.
 *
 * what the two share is the ban on invention. the scribe reads one tool and may
 * state nothing that tool did not return, because its output goes into a public
 * policy document and a regulator's file.
 */

import { getFunctionCalls, InMemorySessionService, LlmAgent, Runner } from "@google/adk";

import type { DriftOptions } from "./drift.js";
import type { Store } from "./firestore.js";
import { createGetDriftContextTool } from "./tools/get-drift-context.js";
import { createWriteRedlineTool } from "./tools/write-redline.js";

/** the ADK app name, used to scope sessions */
const APP_NAME = "pixel-patrol-scribe";

/** the user id every autonomous run acts as — there is no human in this loop */
const SYSTEM_USER = "pixel-patrol-system";

/**
 * the scribe's standing orders.
 *
 * written in English about Czech output on purpose: the model follows English
 * instructions more reliably, and the constraint that matters — say only what
 * the tool returned — has to be unambiguous. the unknown-vendor branch is
 * spelled out because it is the common case: a tracker nobody recognises is
 * exactly the kind that appears without anyone deciding to add it.
 */
export const SCRIBE_INSTRUCTION = `You are Pixel Patrol's compliance scribe. Tracking that nobody approved has appeared on a website. Produce the paperwork its owner now owes: an edit to their cookie policy, and a row for their records of processing activities (záznamy o činnostech zpracování).

Procedure:
1. Call get_drift_context.
2. Call write_redline exactly once, with both documents. Then stop.

Everything you write is in Czech, for a Czech site owner and a Czech supervisory authority (ÚOOÚ).

policyRedline is a list of edit instructions, not an essay. Each instruction starts with "Přidat:" or "Odstranit:" and says exactly what text to add to or remove from the cookie policy. For every domain in hosts, write an entry naming the domain, its operator if one is known, what it does, the consent category it belongs in, and the cookie names and durations from cookies where there are any. Convert a typical_duration_seconds into a human duration in Czech. Close with a short "Poznámka:" paragraph telling the owner what they must decide themselves. Plain sentences a non-lawyer can paste and edit, not legal boilerplate.

ropaRow is one row describing this processing activity:
- name: what the activity is, e.g. "Měření návštěvnosti webu <doména>" — use the site's own URL.
- purpose: what the tracking is for, from what the tables say about it.
- legal_basis: for analytics and marketing tracking this is consent, "Souhlas (čl. 6 odst. 1 písm. a) GDPR)". Only write a different basis if the tables show the tracker is strictly necessary.
- data_categories: the kinds of personal data involved — identifiers in cookies, IP address, device and browser data. Name only what a tracker of this kind actually collects.
- data_subject_categories: who the data is about, e.g. "Návštěvníci webu".
- recipients: the operator of each domain, or the domain itself when no operator is known.
- retention_period: the cookie durations where the tables give them, otherwise "Neurčeno — nutno zjistit u provozovatele".
- third_country_transfers: whether data may leave the EU. Say so only if the tables identify a vendor known to be outside the EU; otherwise "Nezjištěno".
- is_dpia_required: true only when the tracking involves systematic monitoring on a large scale. Unknown single trackers are false.
- notes: what stayed unknown, in one or two sentences.

Rules:
- State only what get_drift_context returned. Never name a company, a purpose, a retention period or a transfer destination the tool did not give you.
- When a domain's "exact" is null and "related" is empty, that domain is unidentified. Say so plainly in Czech ("provozovatel nebyl zjištěn") and tell the owner to establish who runs it before publishing the policy. Do not fill the gap with a plausible vendor.
- The decision's classifications carry the analyst's judgement and its basis. Use them, and do not upgrade a "low" confidence classification into a statement of fact.
- Call write_redline exactly once, and make it your last tool call.
- Finish with one sentence saying what you wrote. No preamble, no questions.`;

/** what one scribe run produced */
export interface ScribeResult {
  /** the model's closing sentence, empty when it ended on a tool call */
  finalText: string;
  /** the tools it called, in order, for the log */
  toolCalls: string[];
}

/**
 * builds the scribe agent.
 *
 * @param store the Firestore accessors its tools read and write through
 * @param model the Gemini model id
 * @param options the stability window rules, so its diff matches the analyst's
 * @returns the configured agent
 */
export function buildScribeAgent(
  store: Store,
  model: string,
  options: DriftOptions,
): LlmAgent {
  return new LlmAgent({
    name: "compliance_scribe",
    model,
    description:
      "Turns a recorded drift decision into a Czech cookie-policy redline and a RoPA row.",
    instruction: SCRIBE_INSTRUCTION,
    tools: [createGetDriftContextTool(store, options), createWriteRedlineTool(store, model)],
  });
}

/**
 * builds a runner for the scribe.
 *
 * @param store the Firestore accessors
 * @param model the Gemini model id
 * @param options the stability window rules
 * @returns a runner ready to accept drift decisions
 */
export function createScribeRunner(
  store: Store,
  model: string,
  options: DriftOptions,
): Runner {
  return new Runner({
    appName: APP_NAME,
    agent: buildScribeAgent(store, model, options),
    sessionService: new InMemorySessionService(),
  });
}

/**
 * runs the scribe over one recorded drift decision and drains its event stream.
 *
 * @param runner the scribe runner
 * @param input the sweep whose decision to document
 * @returns the model's closing sentence and the tools it called
 */
export async function writeRedlineFor(
  runner: Runner,
  input: { siteId: string; sweepId: string },
): Promise<ScribeResult> {
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
          text: `Sweep ${input.sweepId} on site ${input.siteId} recorded tracking drift. Write the cookie policy redline and the RoPA row.`,
        },
      ],
    },
  })) {
    for (const call of getFunctionCalls(event)) {
      if (call.name) toolCalls.push(call.name);
    }
    const text = (event.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    if (text) finalText = text;
  }

  return { finalText, toolCalls };
}
