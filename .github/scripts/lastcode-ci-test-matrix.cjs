const isolatedJobs = [
  { name: "Test Mobile", filters: "@t3tools/mobile", desktop: false },
  { name: "Test Scripts", filters: "@t3tools/scripts", desktop: false },
  { name: "Test Shared", filters: "@t3tools/shared", desktop: false },
];
const isolatedPackages = isolatedJobs.map(({ filters }) => filters);
const defaultExclusions = ["t3", "@t3tools/monorepo", "@t3tools/web", ...isolatedPackages];

function testMatrix(testPackages = "") {
  const packages = testPackages.trim().split(/\s+/).filter(Boolean);
  const full = packages.length === 0;
  const mainFilters = full
    ? defaultExclusions.map((name) => `!${name}`)
    : packages.filter((name) => !isolatedPackages.includes(name));
  const rows = isolatedJobs.filter(({ filters }) => full || packages.includes(filters));
  if (mainFilters.length > 0) {
    rows.unshift({ name: "Test", filters: mainFilters.join(" "), desktop: true });
  }
  // The workflow tests previously ran on every non-skipped Test job.
  return { include: rows.map((row, index) => ({ ...row, workflowTests: index === 0 })) };
}

if (require.main === module) {
  console.log(`matrix=${JSON.stringify(testMatrix(process.env.TEST_PACKAGES))}`);
}

module.exports = { testMatrix };
