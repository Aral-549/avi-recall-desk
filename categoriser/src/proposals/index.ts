import {
  CategoriserError,
  TagProposalDecisionSchema,
  type StoredTagProposal,
  type TagProposalDecision,
} from "../schemas/index.js";
import type { StorageAdapter } from "../storage/index.js";
import { TaxonomyIndex } from "../taxonomy/index.js";

const STAGE = "proposals";

export type DecisionResult = {
  proposal: StoredTagProposal;
  /** Taxonomy version after the decision. Unchanged for rejects and for tags that already exist. */
  taxonomyVersion: number;
  taxonomyChanged: boolean;
};

/**
 * Approve appends the tag to the user's taxonomy (version + 1); reject only records the decision.
 * If the tag already resolves (another item proposed it and it was approved), approve just marks
 * this proposal approved. Taxonomy is written before the proposal state, so a crash in between
 * leaves a pending proposal whose re-approval is a no-op on the taxonomy.
 */
export async function decideTagProposal(input: TagProposalDecision, deps: { storage: StorageAdapter }): Promise<DecisionResult> {
  const parsed = TagProposalDecisionSchema.safeParse(input);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ");
    throw new CategoriserError("validation", STAGE, `decision: invalid input at ${paths}`);
  }
  const { userId, proposalId, decision } = parsed.data;
  const { storage } = deps;

  const proposal = await storage.getTagProposal(userId, proposalId);
  if (!proposal) throw new CategoriserError("not_found", STAGE, "tag proposal not found");
  if (proposal.state !== "pending") throw new CategoriserError("invalid_state", STAGE, `proposal already ${proposal.state}`);

  let taxonomy = await storage.getTaxonomy(userId);
  let taxonomyChanged = false;
  if (decision === "approve") {
    const index = new TaxonomyIndex(taxonomy);
    if (!index.resolve(proposal.tag)) {
      taxonomy = index.approveProposal(proposal.tag, proposal.reason);
      await storage.putTaxonomy(userId, taxonomy);
      taxonomyChanged = true;
    }
  }
  const state = decision === "approve" ? "approved" : "rejected";
  await storage.setTagProposalState(userId, proposalId, state);
  return { proposal: { ...proposal, state }, taxonomyVersion: taxonomy.version, taxonomyChanged };
}
