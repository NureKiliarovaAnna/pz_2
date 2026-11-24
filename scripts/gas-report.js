// Runs the whole test suite with hardhat-gas-reporter enabled and saves
// the per-function table to docs/gas/gas-report.txt (cross-platform).
const { spawnSync } = require("child_process");
const path = require("path");

const outputFile = path.join("docs", "gas", "gas-report.txt");

const result = spawnSync("npx", ["hardhat", "test"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, REPORT_GAS: "true", GAS_REPORT_FILE: outputFile },
});

console.log(`\nGas report saved to ${outputFile}`);
process.exit(result.status ?? 1);
