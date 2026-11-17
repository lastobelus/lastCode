const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("yaml");
const workflow = parse(fs.readFileSync(path.join(__dirname, "../workflows/ci.yml"), "utf8"));
const step = workflow.jobs.ci_gate.steps.find(
  (step) => step.name === "Verify source CI for metadata edit",
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction("github", "context", "core", "setTimeout", step.with.script);
const verify = ({ github, context, core, wait }) =>
  run(github, context, core, (resolve, ms) => {
    wait(ms);
    resolve();
  });

const title = "CI pull_request PR #42 head head base base merge merge";
const source = {
  id: 10,
  display_title: title,
  head_sha: "head",
  event: "pull_request",
  status: "completed",
  conclusion: "success",
  run_attempt: 2,
  html_url: "https://github.com/example/repo/actions/runs/10",
};
const jobs = ["Check", "CI Gate"].map((name) => ({
  name,
  status: "completed",
  conclusion: "success",
}));
function fixture(runs = [source], sourceJobs = jobs) {
  const reads = [];
  const messages = [];
  const listRuns = Symbol("runs");
  const listJobs = Symbol("jobs");
  const summary = {
    addHeading() {
      return this;
    },
    addLink() {
      return this;
    },
    addRaw() {
      return this;
    },
    async write() {
      messages.push("verified");
    },
  };
  return {
    reads,
    messages,
    github: {
      rest: { actions: { listWorkflowRuns: listRuns, listJobsForWorkflowRunAttempt: listJobs } },
      async paginate(method, args) {
        reads.push(args);
        return method === listRuns ? runs : sourceJobs;
      },
    },
    context: {
      repo: { owner: "example", repo: "repo" },
      runId: 20,
      sha: "merge",
      payload: { pull_request: { number: 42, head: { sha: "head" }, base: { sha: "base" } } },
    },
    core: {
      info(message) {
        messages.push(message);
      },
      summary,
    },
    wait() {
      throw new Error("unexpected wait");
    },
  };
}

test("metadata gate requires source success for the exact head, base and merge, never a skipped or metadata gate", async () => {
  const valid = fixture();
  await verify(valid);
  assert.deepEqual(valid.reads[1], {
    owner: "example",
    repo: "repo",
    run_id: 10,
    attempt_number: 2,
    per_page: 100,
  });
  assert.deepEqual(valid.messages, ["verified"]);
  for (const run of [
    { ...source, display_title: `Metadata only: ${title}` },
    { ...source, display_title: title.replace("head head", "head other") },
    { ...source, display_title: title.replace("base base", "base other") },
    { ...source, display_title: title.replace("merge merge", "merge other") },
    { ...source, display_title: title.replace("#42", "#43") },
    { ...source, head_sha: "other" },
    { ...source, event: "push" },
    { ...source, id: 20 },
  ])
    await assert.rejects(verify(fixture([run])), /No source CI/);
  await assert.rejects(verify(fixture([])), /No source CI/);
  for (const conclusion of ["failure", "cancelled", "skipped", "neutral", null]) {
    await assert.rejects(verify(fixture([{ ...source, conclusion }])), /concluded/);
    for (const name of ["Check", "CI Gate"]) {
      await assert.rejects(
        verify(
          fixture(
            [source],
            jobs.map((job) => (job.name === name ? { ...job, conclusion } : job)),
          ),
        ),
        /no successful/,
      );
    }
  }
  await assert.rejects(verify(fixture([source], [])), /no successful/);
  await assert.rejects(
    verify(fixture([source, { ...source, id: 11, conclusion: "failure" }])),
    /concluded failure/,
  );
});

test("an edit during source CI waits for real evidence and fails closed on errors or expiry", async () => {
  const pending = { ...source, status: "in_progress", conclusion: null };
  const f = fixture([pending]);
  f.wait = () => {
    pending.status = "completed";
    pending.conclusion = "success";
  };
  await verify(f);
  assert.equal(f.messages.at(-1), "verified");
  const expired = fixture([{ ...source, status: "queued", conclusion: null }]);
  expired.wait = () => {};
  await assert.rejects(verify(expired), /still pending/);
  const denied = fixture();
  denied.github.paginate = async () => {
    throw new Error("permission denied");
  };
  await assert.rejects(verify(denied), /permission denied/);
});
