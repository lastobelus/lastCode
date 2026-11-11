import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { validatePilot } from "./lib/server-test-pilot.mjs";

const directory = NodePath.resolve(process.argv[2]);
const receipts = ["baseline", "1", "2"].map((cohort) =>
  JSON.parse(
    NodeFS.readFileSync(NodePath.join(directory, `pilot-${cohort}`, "receipt.json"), "utf8"),
  ),
);
const report = validatePilot(receipts);
NodeFS.writeFileSync(
  NodePath.join(directory, "pilot-summary.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  NodeFS.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `\nAdvisory server pilot (Linux only; no promotion stamp)\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`,
  );
}
