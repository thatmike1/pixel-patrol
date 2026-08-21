/**
 * assembles the analyst's toolset.
 *
 * the order here is the order the model sees them declared, which mirrors the
 * order the instruction asks for them in: look, compare, act, record.
 */

import type { BaseTool } from "@google/adk";

import type { DriftOptions } from "../drift.js";
import type { Store } from "../firestore.js";
import { createApproveBaselineTool } from "./approve-baseline.js";
import { createDiffAgainstBaselineTool } from "./diff-against-baseline.js";
import { createGetSweepContextTool } from "./get-sweep-context.js";
import { createRecordDecisionTool } from "./record-decision.js";

/**
 * builds every tool the drift analyst can call.
 *
 * @param store the Firestore accessors the tools read and write through
 * @param model the model id stamped onto recorded decisions
 * @param options the stability window rules the two drift tools share
 * @returns the toolset, in declaration order
 */
export function createTools(store: Store, model: string, options: DriftOptions): BaseTool[] {
  return [
    createGetSweepContextTool(store, options),
    createDiffAgainstBaselineTool(store, options),
    createApproveBaselineTool(store),
    createRecordDecisionTool(store, model, options),
  ];
}
