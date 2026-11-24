// Verifies the deployed contracts on Etherscan using deployments/<network>.json.
//   npx hardhat run scripts/verify.js --network sepolia
// Requires ETHERSCAN_API_KEY in .env.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const file = path.join(
    __dirname,
    "..",
    "deployments",
    `${hre.network.name}.json`
  );

  if (!fs.existsSync(file)) {
    throw new Error(`No deployment file ${file}. Run scripts/deploy.js first.`);
  }

  if (!process.env.ETHERSCAN_API_KEY) {
    throw new Error("Set ETHERSCAN_API_KEY in .env");
  }

  const { contracts } = JSON.parse(fs.readFileSync(file, "utf8"));

  for (const [name, { address, constructorArgs }] of Object.entries(contracts)) {
    console.log(`\nVerifying ${name} at ${address}`);
    try {
      await hre.run("verify:verify", {
        address,
        constructorArguments: constructorArgs,
        contract: `contracts/${name}.sol:${name}`,
      });
    } catch (error) {
      if (/already verified/i.test(error.message)) {
        console.log("  already verified");
      } else {
        throw error;
      }
    }
    console.log(`  https://sepolia.etherscan.io/address/${address}#code`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
