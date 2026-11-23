const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { decide, readWorkspace } = require("./ci-changes.cjs");
const { testMatrix } = require("./lastcode-ci-test-matrix.cjs");

test("full CI runs each package in its assigned job", () => {
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
});

test("filtered CI schedules only affected packages", () => {
  const workspace = readWorkspace();
  const scripts = decide(["scripts/check-changed.ts"], workspace, false).outputs;
  const mobile = decide(["apps/mobile/src/Example.ts"], workspace, false).outputs;
  const desktop = decide(["apps/desktop/src/Example.ts"], workspace, false).outputs;
  const docs = decide(["docs/guide.md"], workspace, false).outputs;
  assert.deepEqual(testMatrix(scripts.test_packages).include, [
    { name: "Test Scripts", filters: "@t3tools/scripts" },
  ]);
  assert.deepEqual(testMatrix(mobile.test_packages).include, [
    { name: "Test Mobile", filters: "@t3tools/mobile" },
    { name: "Test Scripts", filters: "@t3tools/scripts" },
  ]);
  const desktopRows = testMatrix(desktop.test_packages).include;
  assert.deepEqual(
    desktopRows.flatMap(({ filters }) => filters.split(" ")).sort(),
    desktop.test_packages.split(" ").sort(),
  );
  assert.equal(docs.test, false);
});

test("the release workflow uses the same full package split as CI", () => {
  const { parse } = require("yaml");
  const release = parse(fs.readFileSync(path.join(__dirname, "../workflows/release.yml"), "utf8"));
  const packageFilters = (rows) => rows.map(({ filters }) => filters);
  assert.deepEqual(
    packageFilters(release.jobs.test.strategy.matrix.include),
    packageFilters(testMatrix().include),
  );
});
