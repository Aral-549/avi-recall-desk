/**
 * Idea Lab, simulated. Replies come from fixtures picked deterministically from the prompt.
 * Long asks become Jobs whose stage is a pure function of elapsed time, so leaving or reloading resumes them.
 */
import { matchTags } from "./categoriser";
import { hash32 } from "./seeded";
import type { TagId } from "./taxonomy";
import type { IdeaCard, Job, JobStage } from "./types";

const IDEAS: Omit<IdeaCard, "id">[] = [
  { title: "Portfolio as a changelog", body: "Replace the project grid with dated entries. Each one is a decision and its outcome, newest first.", tags: ["design-ui", "inspiration"] },
  { title: "One-accent audit", body: "Screenshot every page, desaturate everything except the accent. If it shows up more than twice per screen, it stops meaning anything.", tags: ["design-ui"] },
  { title: "Case study in 4 frames", body: "Problem, the constraint that hurt, the call you made, the number that moved. Nothing else above the fold.", tags: ["design-ui", "career-study"] },
  { title: "Weekly scrap digest", body: "Every Friday, collect the week's confirmed scraps into one markdown note. It writes the 'what I learned' post for you.", tags: ["tool-library", "article"] },
  { title: "Tag drift alarm", body: "When the same tag gets rejected three times in a row, ask whether the taxonomy is wrong instead of the item.", tags: ["ai-ml", "tool-library"] },
  { title: "Reading pile triage", body: "Give every article a 'still want this?' date. Unread past it, the scrap fades a little. Nothing is deleted.", tags: ["article"] },
  { title: "Prompt as a scrap", body: "Save prompts that worked next to the output they produced, so the board doubles as a prompt library.", tags: ["ai-ml"] },
  { title: "Motion budget", body: "Allow three durations in the whole product and write them on a sticky note. New animation? Pick one of the three.", tags: ["design-ui", "web-dev"] },
  { title: "Hackathon starter kit", body: "Pre-pin auth, a database and a deploy button to a collection before the weekend. Day one is for the idea.", tags: ["hackathon", "web-dev", "tool-library"] },
  { title: "Static-first side project", body: "Ship it as a static export first. If nobody asks for sync in a month, you saved a backend.", tags: ["web-dev", "open-source"] },
  { title: "Interview story bank", body: "Tag scraps with the story they prove. Before an interview, filter by tag and rehearse the top three.", tags: ["career-study"] },
  { title: "Open-source the boring part", body: "Extract the export code into a tiny library. It's the part other people actually need.", tags: ["open-source", "tool-library"] },
];

export const QUICK_REPLIES = [
  "Short version: start from the scrap you keep reopening. That's usually the real project.",
  "I'd cut the scope in half and make the half that's left feel finished.",
  "Try writing the README first. If it's boring to write, it'll be boring to use.",
  "Pick one constraint and lean on it: one font, one accent, one verb.",
];

export const IDEA_PROMPTS = ["Search for portfolio ideas", "Brainstorm side-project features", "Ideas from my reading pile"];

/** Asks that "search" or "brainstorm" become background jobs; everything else gets a quick reply. */
export function isLongAsk(prompt: string) {
  return /\b(search|find|brainstorm|ideas?|research|explore|look up)\b/i.test(prompt);
}

export function quickReply(prompt: string) {
  return QUICK_REPLIES[hash32(prompt.toLowerCase().trim()) % QUICK_REPLIES.length];
}

export function draftIdeas(prompt: string, boardTags: TagId[], jobId: string): IdeaCard[] {
  const { tags } = matchTags(prompt);
  const want = new Set<TagId>([...tags, ...boardTags.slice(0, 2)]);
  const seed = hash32(prompt.toLowerCase());
  const scored = IDEAS.map((idea, i) => ({
    idea,
    i,
    score: idea.tags.filter((t) => want.has(t as TagId)).length * 10 + ((seed >> (i % 16)) & 7),
  })).sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, 4).map(({ idea, i }) => ({ ...idea, tags: idea.tags as TagId[], id: `${jobId}:${i}` }));
}

export function planFor(prompt: string) {
  const h = hash32(prompt);
  return { queued: 900, searching: 900 + 3200 + (h % 1500), drafting: 900 + 3200 + (h % 1500) + 2600 };
}

export function jobStage(job: Job, now = Date.now()): JobStage {
  const elapsed = now - Date.parse(job.startedAt);
  if (elapsed < job.plan.queued) return "queued";
  if (elapsed < job.plan.searching) return "searching";
  if (elapsed < job.plan.drafting) return "drafting";
  return "done";
}

export const JOB_COPY: Record<JobStage, string> = {
  queued: "In the queue. Go do something else.",
  searching: "Flipping through your scraps and the fixtures.",
  drafting: "Sharpening the pencil, drafting cards.",
  done: "Done. Four ideas, no filler.",
};
