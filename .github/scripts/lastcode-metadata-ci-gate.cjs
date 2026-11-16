// Metadata suites must report the exact required name, even with source jobs skipped.
// Keep CI Gate present, but never turn skipped metadata jobs into CI evidence.
module.exports = async function verifyMetadataCi({
  github,
  context,
  core,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;
  const title = `CI pull_request PR #${pr.number} head ${pr.head.sha} base ${pr.base.sha} merge ${context.sha}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
      owner,
      repo,
      workflow_id: "ci.yml",
      event: "pull_request",
      head_sha: pr.head.sha,
      per_page: 100,
    });
    const source = runs
      .filter(
        (run) =>
          run.id !== context.runId &&
          run.display_title === title &&
          run.head_sha === pr.head.sha &&
          run.event === "pull_request",
      )
      .sort((a, b) => b.id - a.id)[0];
    if (!source)
      throw new Error(`No source CI run for ${title}. Source CI must validate this merge commit.`);
    if (source.status !== "completed") {
      core.info(`Waiting for source CI ${source.html_url}`);
      await wait(30_000);
      continue;
    }
    if (source.conclusion !== "success")
      throw new Error(`Source CI ${source.html_url} concluded ${source.conclusion}.`);
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, {
      owner,
      repo,
      run_id: source.id,
      attempt_number: source.run_attempt,
      per_page: 100,
    });
    for (const name of ["Check", "CI Gate"]) {
      const job = jobs.find((job) => job.name === name);
      if (job?.status !== "completed" || job.conclusion !== "success") {
        throw new Error(`Source CI ${source.html_url} has no successful ${name} job.`);
      }
    }
    await core.summary
      .addHeading("Source CI verified")
      .addLink(`Run ${source.id}, attempt ${source.run_attempt}`, source.html_url)
      .addRaw(`\n\nHead: ${pr.head.sha}\n\nBase: ${pr.base.sha}\n\nMerge: ${context.sha}\n`)
      .write();
    return;
  }
  throw new Error(
    "Source CI is still pending. Re-run this metadata gate after source CI finishes.",
  );
};
