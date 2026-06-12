/**
 * Code-review workflow — the root Render Workflow task.
 *
 * Each reviewer is registered as its own `task()` directly — no wrapper, no
 * indirection. Inside the root task, `prepareDiff` runs in-process and each
 * reviewer runs as its own chained Render task via `Promise.all` — the same
 * fan-out as naive-agent and worker-agents, but each agent in its own isolated
 * instance.
 *
 * The agents themselves come from @workshop/agent — identical to the ones the
 * naive and worker patterns run.
 */
import { task } from "@renderinc/sdk/workflows";
import {
  prepareDiff,
  filterDiff,
  toReviewSummary,
  securityReviewer,
  performanceReviewer,
  uxReviewer,
  hasFrontendFiles,
  judge,
} from "@workshop/agent";
import { storeTracer } from "@workshop/db";

// Each shared agent is registered as its own Render task. The `task()` call is
// the whole bridge — `agent.run()` is the same call naive-agent and
// worker-agents make; wrapping it in `task()` buys isolation, retries, and traces.
type Patches = Array<{ file: string; diff: string }>;
type Findings = Array<{ agent: string; note: string }>;
const ctx = (runId?: string) => ({ tracer: storeTracer(), ...(runId ? { runId } : {}) });

const agentTaskOptions = {
  timeoutSeconds: 120,
  retry: { maxRetries: 2, waitDurationMs: 1000, backoffScaling: 2 },
};

const securityTask = task(
  { name: "security", ...agentTaskOptions },
  async (input: { patches: Patches }, runId?: string) => securityReviewer.run(input, ctx(runId)),
);

const performanceTask = task(
  { name: "performance", ...agentTaskOptions },
  async (input: { patches: Patches }, runId?: string) => performanceReviewer.run(input, ctx(runId)),
);

const uxTask = task(
  { name: "ux", ...agentTaskOptions },
  async (input: { patches: Patches }, runId?: string) => uxReviewer.run(input, ctx(runId)),
);

const judgeTask = task(
  { name: "judge", ...agentTaskOptions },
  async (input: { findings: Findings }, runId?: string) => judge.run(input, ctx(runId)),
);

interface CodeReviewInput {
  url: string;
  labels?: string[];
  _runId?: string;
}

export default task(
  {
    name: "code-review",
    timeoutSeconds: 600,
    retry: { maxRetries: 2, waitDurationMs: 2000, backoffScaling: 2 },
  },
  async function codeReview(input: CodeReviewInput) {
    const runId = input._runId;

    const allPatches = await prepareDiff({ url: input.url, labels: input.labels ?? [] });
    const { patches } = filterDiff(allPatches);

    // Conditional fan-out: security + performance always; UX only for frontend.
    const reviewerTasks = [
      { name: securityReviewer.name, run: securityTask },
      { name: performanceReviewer.name, run: performanceTask },
    ];
    if (hasFrontendFiles(patches)) {
      reviewerTasks.push({ name: uxReviewer.name, run: uxTask });
    }

    const reviewerResults = await Promise.all(
      reviewerTasks.map(async ({ name, run }) => {
        const result = await run({ patches }, runId);
        return { agent: name, note: result.text, usage: result.usage };
      }),
    );

    const decision = await judgeTask({ findings: reviewerResults.map(({ agent, note }) => ({ agent, note })) }, runId);

    return toReviewSummary(reviewerResults, decision);
  },
);
