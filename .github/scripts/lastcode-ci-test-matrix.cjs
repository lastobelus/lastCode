const isolatedJobs = [
  { name: "Test Mobile", filters: "@t3tools/mobile" },
  { name: "Test Scripts", filters: "@t3tools/scripts" },
  { name: "Test Shared", filters: "@t3tools/shared" },
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
    rows.unshift({ name: "Test", filters: mainFilters.join(" ") });
  }
  return { include: rows };
}

if (require.main === module) {
  console.log(`matrix=${JSON.stringify(testMatrix(process.env.TEST_PACKAGES))}`);
}

module.exports = { testMatrix };
