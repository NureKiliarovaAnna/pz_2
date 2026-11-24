// Deploys DAOToken, DAOTreasury and DAOGovernor and links them.
//
// All parameters come from environment variables (see .env.example);
// no keys or addresses are hard-coded. Unset values default to the deployer.
//
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/deploy.js --network sepolia
//
// Output: deployments/<network>.json and frontend/config.js
const fs = require("fs");
const path = require("path");
const { ethers, network, artifacts } = require("hardhat");

const ROOT = path.join(__dirname, "..");

function envAddress(name, fallback) {
  const value = (process.env[name] || "").trim();
  if (!value) return fallback;
  if (!ethers.isAddress(value)) {
    throw new Error(`${name} is not a valid address: ${value}`);
  }
  return ethers.getAddress(value);
}

/// TOKEN_DISTRIBUTION="0xAbc...:400,0xDef...:100" (amounts in DVT)
function parseDistribution(raw) {
  if (!raw || !raw.trim()) return [];
  return raw.split(",").map((pair) => {
    const [address, amount] = pair.split(":").map((s) => s.trim());
    if (!ethers.isAddress(address) || !amount) {
      throw new Error(`Invalid TOKEN_DISTRIBUTION entry: ${pair}`);
    }
    return { address: ethers.getAddress(address), amount };
  });
}

async function waitDeployed(contract, label) {
  await contract.waitForDeployment();
  const tx = contract.deploymentTransaction();
  const receipt = await tx.wait();
  console.log(
    `  ${label.padEnd(12)} ${contract.target}  (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`
  );
  return receipt;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      `No deployer account for network "${network.name}". ` +
        "Set SEPOLIA_PRIVATE_KEY in .env."
    );
  }

  const { chainId } = await ethers.provider.getNetwork();

  const params = {
    tokenHolder: envAddress("TOKEN_HOLDER", deployer.address),
    admin: envAddress("ADMIN_ADDRESS", deployer.address),
    proposer: envAddress("PROPOSER_ADDRESS", deployer.address),
    guardian: envAddress("GUARDIAN_ADDRESS", deployer.address),
    votingPeriod: BigInt(process.env.VOTING_PERIOD || "300"),
    initialDeposit: ethers.parseEther(process.env.INITIAL_DEPOSIT_ETH || "0"),
    distribution: parseDistribution(process.env.TOKEN_DISTRIBUTION),
  };

  console.log(`Network:  ${network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(
    `Balance:  ${ethers.formatEther(
      await ethers.provider.getBalance(deployer.address)
    )} ETH`
  );
  console.log("Parameters:", {
    ...params,
    votingPeriod: `${params.votingPeriod} s`,
    initialDeposit: `${ethers.formatEther(params.initialDeposit)} ETH`,
  });

  console.log("\nDeploying:");
  const token = await ethers.deployContract("DAOToken", [params.tokenHolder]);
  const tokenReceipt = await waitDeployed(token, "DAOToken");

  const treasury = await ethers.deployContract("DAOTreasury", [
    params.admin,
    params.guardian,
  ]);
  await waitDeployed(treasury, "DAOTreasury");

  const governor = await ethers.deployContract("DAOGovernor", [
    token.target,
    treasury.target,
    params.admin,
    params.proposer,
    params.guardian,
    params.votingPeriod,
  ]);
  await waitDeployed(governor, "DAOGovernor");

  console.log("\nConfiguring:");
  if (params.admin === deployer.address) {
    await (await treasury.setGovernor(governor.target)).wait();
    console.log(`  treasury.setGovernor(${governor.target})`);
  } else {
    console.log(
      `  SKIPPED setGovernor: only the admin ${params.admin} may call ` +
        `treasury.setGovernor(${governor.target}).`
    );
  }

  if (params.initialDeposit > 0n) {
    await (await treasury.deposit({ value: params.initialDeposit })).wait();
    console.log(
      `  treasury.deposit(${ethers.formatEther(params.initialDeposit)} ETH)`
    );
  }

  if (params.distribution.length > 0) {
    if (params.tokenHolder !== deployer.address) {
      throw new Error("TOKEN_DISTRIBUTION requires TOKEN_HOLDER = deployer");
    }
    for (const { address, amount } of params.distribution) {
      await (await token.transfer(address, ethers.parseEther(amount))).wait();
      console.log(`  token.transfer(${address}, ${amount} DVT)`);
    }
  }

  const deployment = {
    network: network.name,
    chainId: Number(chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    startBlock: tokenReceipt.blockNumber,
    parameters: {
      tokenHolder: params.tokenHolder,
      admin: params.admin,
      proposer: params.proposer,
      guardian: params.guardian,
      votingPeriod: Number(params.votingPeriod),
    },
    contracts: {
      DAOToken: {
        address: token.target,
        constructorArgs: [params.tokenHolder],
      },
      DAOTreasury: {
        address: treasury.target,
        constructorArgs: [params.admin, params.guardian],
      },
      DAOGovernor: {
        address: governor.target,
        constructorArgs: [
          token.target,
          treasury.target,
          params.admin,
          params.proposer,
          params.guardian,
          Number(params.votingPeriod),
        ],
      },
    },
  };

  const deploymentsDir = path.join(ROOT, "deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const deploymentFile = path.join(deploymentsDir, `${network.name}.json`);
  fs.writeFileSync(deploymentFile, JSON.stringify(deployment, null, 2) + "\n");

  await writeFrontendConfig(deployment);

  console.log(`\nSaved ${path.relative(ROOT, deploymentFile)}`);
  console.log("Saved frontend/config.js");
}

/// Writes addresses and ABIs for every deployed network into the frontend.
async function writeFrontendConfig(latest) {
  const deploymentsDir = path.join(ROOT, "deployments");
  const networks = {};

  for (const file of fs.readdirSync(deploymentsDir)) {
    if (!file.endsWith(".json")) continue;
    const d = JSON.parse(fs.readFileSync(path.join(deploymentsDir, file)));
    if (d.network === "hardhat") continue; // in-memory network, not reachable
    networks[d.chainId] = {
      name: d.network,
      startBlock: d.startBlock,
      votingPeriod: d.parameters.votingPeriod,
      addresses: Object.fromEntries(
        Object.entries(d.contracts).map(([k, v]) => [k, v.address])
      ),
    };
  }

  const abis = {};
  for (const name of ["DAOToken", "DAOTreasury", "DAOGovernor"]) {
    abis[name] = (await artifacts.readArtifact(name)).abi;
  }

  const content =
    "// Generated by scripts/deploy.js. Do not edit by hand.\n" +
    `window.DAO_CONFIG = ${JSON.stringify(
      { defaultChainId: latest.chainId, networks, abis },
      null,
      2
    )};\n`;

  fs.writeFileSync(path.join(ROOT, "frontend", "config.js"), content);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
