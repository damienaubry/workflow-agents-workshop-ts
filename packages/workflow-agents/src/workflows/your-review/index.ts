/**
 * YOUR REVIEW — Session 2 lab (authored live).
 *
 * Two custom agents, each wrapped in its own `task()`, fanned out in parallel
 * with `Promise.all`, then consolidated by a judge task. This mirrors the
 * finished `code-review` workflow next door — but every reviewer here is one we
 * defined inline with `defineAgent()`. The agent never changed; we just wrapped
 * `.run()` in `task()` and got isolation, retries, timeouts, and per-task
 * traces in the Render Dashboard for free.
 *
 * NOTE: task names are GLOBAL within the workflow service. `code-review`
 * already owns `security`/`performance`/`ux`/`judge`, so the tasks below use
 * distinct names (`clarity`, `error-handling`, `your-judge`) to avoid a
 * registration collision.
 */
import { task } from "@renderinc/sdk/workflows";
import {
  defineAgent,
  prepareDiff,
  filterDiff,
  resolveModelSpec,
  toReviewSummary,
  judge,
} from "@workshop/agent";
import { storeTracer } from "@workshop/db";

type Patches = Array<{ file: string; diff: string }>;
const ctx = (runId?: string) => ({ tracer: storeTracer(), ...(runId ? { runId } : {}) });

const agentTaskOptions = {
  timeoutSeconds: 120,
  retry: { maxRetries: 2, waitDurationMs: 1000, backoffScaling: 2 },
};

// ── Agent 1: clarity / maintainability ──────────────────────────────────────
const clarityReviewer = defineAgent({
  name: "clarity",
  model: resolveModelSpec("medium"),
  tools: ["diff_stats"],
  systemPrompt: `# Clarity reviewer

Review a pull request's per-file patches for clarity and maintainability.

Focus on:
- Confusing variable or function names
- Missing comments on non-obvious logic
- Functions doing too many things (suggest splits)
- Dead code or unreachable branches

Do NOT comment on security or performance — other reviewers handle those.

## Output
A short list of findings, each with:
- **severity**: \`info\` | \`warn\` | \`block\`
- **location**: \`path/to/file:line\`
- **note**: 1-3 sentences: the problem and the fix.
If you find nothing, say so explicitly.`,
});

// ── Agent 2: error handling / resilience ────────────────────────────────────
const errorReviewer = defineAgent({
  name: "error-handling",
  model: resolveModelSpec("medium"),
  tools: ["diff_stats"],
  systemPrompt: `# Error-handling reviewer

Review a pull request's per-file patches for robustness and failure handling.

Focus on:
- Unhandled promise rejections or missing try/catch around I/O
- Swallowed errors (empty catch blocks) or errors logged but not surfaced
- Missing null/undefined guards on external input
- Resource leaks (unclosed connections, missing finally)

Do NOT comment on naming or performance — other reviewers handle those.

## Output
A short list of findings, each with:
- **severity**: \`info\` | \`warn\` | \`block\`
- **location**: \`path/to/file:line\`
- **note**: 1-3 sentences: the problem and the fix.
If you find nothing, say so explicitly.`,
});

// ── Each agent becomes its own Render task ───────────────────────────────────
const clarityTask = task(
  { name: "clarity", ...agentTaskOptions },
  async (input: { patches: Patches }, runId?: string) => clarityReviewer.run(input, ctx(runId)),
);

const errorTask = task(
  { name: "error-handling", ...agentTaskOptions },
  async (input: { patches: Patches }, runId?: string) => errorReviewer.run(input, ctx(runId)),
);

const yourJudgeTask = task(
  { name: "your-judge", ...agentTaskOptions },
  async (input: { findings: Array<{ agent: string; note: string }> }, runId?: string) =>
    judge.run(input, ctx(runId)),
);

interface YourReviewInput {
  url: string;
  _runId?: string;
}

export default task(
  {
    name: "your-review",
    timeoutSeconds: 300,
    retry: { maxRetries: 2, waitDurationMs: 2000, backoffScaling: 2 },
  },
  async function yourReview(input: YourReviewInput) {
    const runId = input._runId;

    // Step 1 — Fetch the PR diff from GitHub (in-process; one HTTP call).
    const allPatches = await prepareDiff({ url: input.url, labels: [] });

    // Step 2 — Drop noise (lock files, minified bundles).
    const { patches } = filterDiff(allPatches);

    // Step 3 — FAN OUT: both custom reviewers run in parallel, each in its own
    // isolated Render instance with its own retry budget and timeout. Same
    // `Promise.all` as code-review — the substrate does the coordination.
    const [clarity, errors] = await Promise.all([
      clarityTask({ patches }, runId),
      errorTask({ patches }, runId),
    ]);

    const reviewerResults = [
      { agent: clarityReviewer.name, note: clarity.text, usage: clarity.usage },
      { agent: errorReviewer.name, note: errors.text, usage: errors.usage },
    ];

    // Step 4 — Judge: consolidate findings into a single verdict (its own task).
    const decision = await yourJudgeTask(
      { findings: reviewerResults.map(({ agent, note }) => ({ agent, note })) },
      runId,
    );

    // Step 5 — Shared summary shape the gateway persists (verdict + reviews).
    return toReviewSummary(reviewerResults, decision);
  },
);
