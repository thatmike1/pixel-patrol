/**
 * `lookup_host_knowledge` — the only thing standing between a domain nobody
 * recognises and an invented vendor name in a compliance document.
 *
 * a drift alert usually names a host the fingerprint could not classify: the
 * scanner's tables had no entry, so the entry reads `vendor: null, category:
 * "unclassified"`. that is exactly the case where a model asked "what is this?"
 * will produce a plausible company. this tool gives it the three tiers the
 * scanner itself used — the table entry, the near matches, the naming heuristic
 * — plus the closed set of categories it may answer with, so a judgement can
 * cite something. when all three tiers are empty the correct answer is
 * `unclassified`, and the instruction says so.
 *
 * no network. the tables are files in the image; a lookup that could reach out
 * to the internet would make a compliance decision depend on whatever a third
 * party served that second.
 */

import { FunctionTool } from "@google/adk";
import { lookupCookieKnowledge, lookupHostKnowledge } from "@pixel-patrol/shared";
import type { CookieKnowledge, HostKnowledge } from "@pixel-patrol/shared";
import { z } from "zod";

/** the arguments the model supplies */
const parameters = z.object({
  registrableDomain: z
    .string()
    .describe("the registrableDomain of an entry in alerts.hostsAdded"),
  exampleHost: z
    .string()
    .describe("the exampleHost the diff reported for that domain; the domain itself will do"),
  cookieNames: z
    .array(z.string())
    .optional()
    .describe("cookie names from alerts.cookiesAdded to look up in the same tables"),
});

/** what the tool returns: the tiers, side by side, plus any cookie entries asked for */
export interface HostKnowledgeResult extends HostKnowledge {
  cookies: CookieKnowledge[];
}

/**
 * gathers the grounding for one domain and, optionally, some cookie names.
 *
 * @param args the domain, an example host, and any cookie names to resolve
 * @returns the table entries, near matches, heuristic verdict and taxonomy
 */
export function hostKnowledge(args: z.infer<typeof parameters>): HostKnowledgeResult {
  return {
    ...lookupHostKnowledge(args.registrableDomain, args.exampleHost),
    cookies: (args.cookieNames ?? []).map(lookupCookieKnowledge),
  };
}

/**
 * builds the tool. it holds no state — the tables are loaded once per process
 * and are read-only — so unlike the others it takes no store.
 *
 * @returns the ADK tool
 */
export function createLookupHostKnowledgeTool(): FunctionTool<typeof parameters> {
  return new FunctionTool({
    name: "lookup_host_knowledge",
    description:
      "Looks a third-party domain up in the same vendor tables the scanner classifies with. " +
      "`exact` is the table entry for this domain or for a parent of the example host, and is " +
      "null when the tables have never seen it. `related` holds table entries that share a " +
      "brand token with it — a different domain belonging to what may be the same vendor; they " +
      "are a lead, not an identification. `relatedCookies` and `cookies` are the same thing for " +
      "the cookie table, the latter for the names you passed in, and carry the Czech purpose " +
      "text and typical duration. `heuristic` is what the hostname's naming convention " +
      "suggests, with the regex that fired; it is weak evidence and never names a vendor. " +
      "`categories` is the closed set of categories you may classify into. All four tiers " +
      "empty means the domain is genuinely unknown.",
    parameters,
    async execute(args): Promise<HostKnowledgeResult> {
      return hostKnowledge(args);
    },
  });
}
