// Deterministic gas benchmark for the main DAO functions.
// Usage: npx hardhat run scripts/gas-benchmark.js
// Optional: GAS_LABEL=before|after saves docs/gas/<label>.json
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function gasOf(txPromise) {
  const receipt = await (await txPromise).wait();
  return receipt.gasUsed;
}

async function main() {
  if (network.name !== "hardhat") {
    throw new Error("Run the benchmark on the in-process hardhat network");
  }

  const [admin, alice, bob, guardian] = await ethers.getSigners();
  const eth = ethers.parseEther;
  const results = {};

  const token = await ethers.deployContract("DAOToken", [admin.address]);
  const treasury = await ethers.deployContract("DAOTreasury", [
    admin.address,
    guardian.address,
  ]);
  const governor = await ethers.deployContract("DAOGovernor", [
    token.target,
    treasury.target,
    admin.address,
    admin.address,
    guardian.address,
    60,
  ]);

  for (const [name, c] of [
    ["DAOToken (deploy)", token],
    ["DAOTreasury (deploy)", treasury],
    ["DAOGovernor (deploy)", governor],
  ]) {
    results[name] = (await c.deploymentTransaction().wait()).gasUsed;
  }

  results["DAOTreasury.setGovernor"] = await gasOf(
    treasury.setGovernor(governor.target)
  );
  results["DAOTreasury.deposit"] = await gasOf(
    treasury.deposit({ value: eth("1") })
  );

  await token.transfer(alice.address, eth("600"));
  await token.transfer(bob.address, eth("400"));
  results["DAOToken.delegate"] = await gasOf(
    token.connect(alice).delegate(alice.address)
  );
  await token.connect(bob).delegate(bob.address);

  results["DAOGovernor.createProposal (first)"] = await gasOf(
    governor.createProposal(bob.address, eth("0.1"), "Fund the DAO website")
  );
  results["DAOGovernor.createProposal (next)"] = await gasOf(
    governor.createProposal(bob.address, eth("0.2"), "Second proposal text")
  );

  results["DAOGovernor.castVote (first vote)"] = await gasOf(
    governor.connect(alice).castVote(1, 1)
  );
  results["DAOGovernor.castVote (second vote)"] = await gasOf(
    governor.connect(bob).castVote(1, 0)
  );

  const proposal = await governor.getProposal(1);
  await ethers.provider.send("evm_setNextBlockTimestamp", [
    Number(proposal.deadline),
  ]);
  await ethers.provider.send("evm_mine", []);

  results["DAOGovernor.execute"] = await gasOf(governor.execute(1));
  results["DAOTreasury.withdraw"] = await gasOf(
    treasury.connect(bob).withdraw()
  );

  console.log("\nFunction".padEnd(42) + "Gas used");
  console.log("-".repeat(52));
  for (const [name, gas] of Object.entries(results)) {
    console.log(name.padEnd(41) + gas.toString().padStart(11));
  }

  if (process.env.GAS_LABEL) {
    const dir = path.join(__dirname, "..", "docs", "gas");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${process.env.GAS_LABEL}.json`);
    const plain = Object.fromEntries(
      Object.entries(results).map(([k, v]) => [k, Number(v)])
    );
    fs.writeFileSync(file, JSON.stringify(plain, null, 2) + "\n");
    console.log(`\nSaved ${path.relative(process.cwd(), file)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
