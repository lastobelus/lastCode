const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { decide, readWorkspace } = require("./ci-changes.cjs");
const { testMatrix } = require("./lastcode-ci-test-matrix.cjs");

test("full CI runs each package in its assigned job and workflow tests once", () => {
  const workspace = readWorkspace();
  const changes = decide([], workspace, true).outputs;
  const { include } = testMatrix(changes.test_packages);
  assert.deepEqual(
    include.map(({ name }) => name),
    ["Test", "Test Mobile", "Test Scripts", "Test Shared"],
  );
  const [main, ...isolated] = include;
  assert.deepEqual(main.filters.split(" ").sort(), [
    "!@t3tools/mobile",
    "!@t3tools/monorepo",
    "!@t3tools/scripts",
    "!@t3tools/shared",
    "!@t3tools/web",
    "!t3",
  ]);
  assert.deepEqual(
    isolated.map(({ filters }) => filters),
    ["@t3tools/mobile", "@t3tools/scripts", "@t3tools/shared"],
  );
  assert.deepEqual(
    include.filter((row) => row.workflowTests),
    [main],
  );
  assert.ok(main.desktop);
  assert.ok(isolated.every((row) => !row.desktop));
});

test("filtered CI schedules only affected packages and still runs the workflow tests", () => {
  const workspace = readWorkspace();
  const scripts = decide(["scripts/check-changed.ts"], workspace, false).outputs;
  const mobile = decide(["apps/mobile/src/Example.ts"], workspace, false).outputs;
  const desktop = decide(["apps/desktop/src/Example.ts"], workspace, false).outputs;
  const docs = decide(["docs/guide.md"], workspace, false).outputs;
  assert.deepEqual(testMatrix(scripts.test_packages).include, [
    { name: "Test Scripts", filters: "@t3tools/scripts", desktop: false, workflowTests: true },
  ]);
  assert.deepEqual(
    testMatrix(mobile.test_packages).include.map(({ name, filters, workflowTests }) => [
      name,
      filters,
      workflowTests,
    ]),
    [
      ["Test Mobile", "@t3tools/mobile", true],
      ["Test Scripts", "@t3tools/scripts", false],
    ],
  );
  const desktopRows = testMatrix(desktop.test_packages).include;
  assert.deepEqual(
    desktopRows.flatMap(({ filters }) => filters.split(" ")).sort(),
    desktop.test_packages.split(" ").sort(),
  );
  assert.deepEqual(
    desktopRows.filter((row) => row.workflowTests),
    [desktopRows[0]],
  );
  assert.equal(docs.test, false);
});

test("the release workflow uses the same full package split as CI", () => {
  const { parse } = require("yaml");
  const release = parse(fs.readFileSync(path.join(__dirname, "../workflows/release.yml"), "utf8"));
  const packageGroups = (rows) => rows.map(({ filters, desktop }) => ({ filters, desktop }));
  assert.deepEqual(
    packageGroups(release.jobs.test.strategy.matrix.include),
    packageGroups(testMatrix().include),
  );
});
