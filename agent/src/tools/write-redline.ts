/**
 * `write_redline` — the scribe's only durable output.
 *
 * one document per sweep, holding the two things a Czech site owner has to
 * produce when a tracker appears: the edit to the public cookie policy, and the
 * row that belongs in the record of processing activities. keyed by sweepId, so
 * a redelivered sweep rewrites its own paperwork instead of leaving two
 * versions of the same finding in the collection.
 */

import { FunctionTool } from "@google/adk";
import { z } from "zod";

import type { Store } from "../firestore.js";
import type { Redline } from "../types.js";

/** the RoPA row, in the gdpr-toolkit's field shape */
const ropaRow = z.object({
  name: z.string().describe("Název činnosti zpracování"),
  purpose: z.string().describe("Účel zpracování"),
  legal_basis: z.string().describe("Právní základ podle čl. 6 GDPR"),
  data_categories: z.array(z.string()).describe("Kategorie osobních údajů"),
  data_subject_categories: z.array(z.string()).describe("Kategorie subjektů údajů"),
  recipients: z.array(z.string()).describe("Příjemci nebo kategorie příjemců"),
  retention_period: z.string().describe("Doba uložení"),
  third_country_transfers: z.string().describe("Předání do třetích zemí"),
  is_dpia_required: z.boolean().describe("Zda je potřeba DPIA"),
  notes: z.string().describe("Poznámky, včetně toho co zůstalo nezjištěné"),
});

/** the arguments the model supplies */
const parameters = z.object({
  siteId: z.string().describe("the site the drift was found on"),
  sweepId: z.string().describe("the sweep that produced the drift decision"),
  policyRedline: z
    .string()
    .describe(
      "Czech redline for the cookie policy: Přidat/Odstranit edit instructions the owner can paste",
    ),
  ropaRow: ropaRow.describe("the RoPA row for this processing activity, in Czech"),
});

/** what the tool confirms back to the model */
export interface WriteRedlineResult {
  ok: true;
  path: string;
}

/** the redline as the model reports it */
export type WriteRedlineArgs = z.infer<typeof parameters>;

/**
 * writes the redline document.
 *
 * separate from the tool wrapper so the idempotency — the part that decides
 * whether a redelivery leaves one document or two — can be tested without a
 * model.
 *
 * @param store the Firestore accessors
 * @param model the model id stamped on the document
 * @param args the redline the scribe wrote
 * @returns where it was written
 */
export async function writeRedline(
  store: Store,
  model: string,
  args: WriteRedlineArgs,
): Promise<WriteRedlineResult> {
  // the domains come off the decision, not off the model's prose: they are the
  // key a ticket or a later sweep matches this paperwork by
  const decision = await store.getDecision(args.siteId, args.sweepId);

  const redline: Redline = {
    siteId: args.siteId,
    sweepId: args.sweepId,
    policyRedline: args.policyRedline,
    ropaRow: args.ropaRow,
    domains: decision?.hostsAdded ?? [],
    at: new Date().toISOString(),
    model,
  };

  await store.writeRedline(redline);
  return { ok: true, path: `sites/${args.siteId}/redlines/${args.sweepId}` };
}

/**
 * builds the tool bound to a store.
 *
 * @param store the Firestore accessors
 * @param model the model id stamped on the document, for provenance
 * @returns the ADK tool
 */
export function createWriteRedlineTool(
  store: Store,
  model: string,
): FunctionTool<typeof parameters> {
  return new FunctionTool({
    name: "write_redline",
    description:
      "Records the cookie-policy redline and the RoPA row for this drift. Call this exactly " +
      "once, as the last thing you do. Everything you write must be in Czech.",
    parameters,
    async execute(args): Promise<WriteRedlineResult> {
      return writeRedline(store, model, args);
    },
  });
}
