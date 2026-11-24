// End-to-end scenario on a running local node, using the same
// frontend/config.js and frontend/errors.js that the web page uses.
//
//   npm run node            (terminal 1)
//   npm run deploy:local    (terminal 2, with TOKEN_DISTRIBUTION, see README)
//   npm run demo:local
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ethers } = require("ethers");

const RPC = "http://127.0.0.1:8545";
const FRONTEND = path.join(__dirname, "..", "frontend");

function loadFrontend() {
  const sandbox = { window: { ethers }, console };
  vm.createContext(sandbox);
  for (const file of ["config.js", "errors.js"]) {
    vm.runInContext(fs.readFileSync(path.join(FRONTEND, file), "utf8"), sandbox);
  }
  return sandbox.window;
}

async function expectRejected(label, explain, action) {
  try {
    await (await action()).wait();
    throw new Error(`${label}: expected a revert`);
  } catch (error) {
    if (error.message.endsWith("expected a revert")) throw error;
    console.log(`  ✗ ${label}\n      → ${explain(error)}`);
  }
}

async function main() {
  const { DAO_CONFIG, DAOErrors } = loadFrontend();
  DAOErrors.init(DAO_CONFIG.abis);
  const explain = DAOErrors.explain;

  const provider = new ethers.JsonRpcProvider(RPC);
  const { chainId } = await provider.getNetwork();
  const deployment = DAO_CONFIG.networks[Number(chainId)];
  if (!deployment) throw new Error(`No deployment for chainId ${chainId}`);

  const [admin, alice, bob] = await Promise.all(
    [0, 1, 2].map((i) => provider.getSigner(i))
  );
  const a = deployment.addresses;
  const contracts = (signer) => ({
    token: new ethers.Contract(a.DAOToken, DAO_CONFIG.abis.DAOToken, signer),
    treasury: new ethers.Contract(a.DAOTreasury, DAO_CONFIG.abis.DAOTreasury, signer),
    governor: new ethers.Contract(a.DAOGovernor, DAO_CONFIG.abis.DAOGovernor, signer),
  });
  const asAdmin = contracts(admin);
  const asAlice = contracts(alice);
  const asBob = contracts(bob);
  const fmt = ethers.formatEther;

  console.log(`Network chainId ${chainId}`);
  console.log(`  admin (proposer): ${admin.address}`);
  console.log(`  alice (voter):    ${alice.address}`);
  console.log(`  bob   (voter):    ${bob.address}\n`);

  console.log("1. Delegation");
  for (const [name, c, signer] of [["alice", asAlice, alice], ["bob", asBob, bob]]) {
    await (await c.token.delegate(signer.address)).wait();
    console.log(`  ${name}: ${fmt(await c.token.getVotes(signer.address))} DVT voting power`);
  }

  console.log("\n2. Proposal");
  const amount = ethers.parseEther("0.5");
  await (await asAdmin.governor.createProposal(alice.address, amount, "Pay Alice for the website")).wait();
  const id = await asAdmin.governor.proposalCount();
  console.log(`  created #${id}: ${fmt(amount)} ETH -> alice`);

  await expectRejected("bob creates a proposal without PROPOSER_ROLE", explain, () =>
    asBob.governor.createProposal(bob.address, 1n, "x")
  );

  console.log("\n3. Voting");
  await (await asAlice.governor.castVote(id, 1)).wait();
  console.log("  alice: for");
  await (await asBob.governor.castVote(id, 0)).wait();
  console.log("  bob: against");
  await expectRejected("alice votes twice", explain, () => asAlice.governor.castVote(id, 1));
  await expectRejected("admin votes with no delegated power", explain, () =>
    asAdmin.governor.castVote(id, 1)
  );
  await expectRejected("execute before the deadline", explain, () =>
    asAdmin.governor.execute(id)
  );

  console.log("\n4. Deadline");
  const proposal = await asAdmin.governor.getProposal(id);
  const block = await provider.getBlock("latest");
  const wait = Number(proposal.deadline) - block.timestamp;
  await provider.send("evm_increaseTime", [Math.max(wait, 0)]);
  await provider.send("evm_mine", []);
  const p = await asAdmin.governor.getProposal(id);
  console.log(
    `  time moved by ${wait}s; for ${fmt(p.forVotes)}, against ${fmt(p.againstVotes)}, ` +
      `quorum ${fmt(await asAdmin.governor.quorum(id))} DVT`
  );
  console.log(`  state: ${DAOErrors.STATE_NAMES[Number(await asAdmin.governor.state(id))]}`);
  await expectRejected("vote after the deadline", explain, () => asBob.governor.castVote(id, 1));

  console.log("\n5. Execution and payout");
  await (await asBob.governor.execute(id)).wait();
  console.log(`  executed by bob; claimable(alice) = ${fmt(await asAdmin.treasury.claimable(alice.address))} ETH`);
  await expectRejected("bob withdraws alice's payout", explain, () => asBob.treasury.withdraw());

  const receipt = await (await asAlice.treasury.withdraw()).wait();
  const withdrawn = receipt.logs
    .map((log) => asAdmin.treasury.interface.parseLog(log))
    .find((event) => event && event.name === "Withdrawn");
  console.log(
    `  alice withdrew ${fmt(withdrawn.args.amount)} ETH in block ${receipt.blockNumber} ` +
      `(gas ${receipt.gasUsed}); claimable now ${fmt(await asAdmin.treasury.claimable(alice.address))}`
  );

  console.log("\n6. Emergency pause");
  await (await asAdmin.governor.pause()).wait();
  await expectRejected("create a proposal while paused", explain, () =>
    asAdmin.governor.createProposal(alice.address, 1n, "x")
  );
  await expectRejected("bob unpauses without the admin role", explain, () =>
    asBob.governor.unpause()
  );
  await (await asAdmin.governor.unpause()).wait();
  console.log("  admin unpaused the governor");

  console.log("\n7. Insufficient treasury funds");
  const big = (await asAdmin.treasury.availableBalance()) + 1n;
  await (await asAdmin.governor.createProposal(bob.address, big, "Too expensive")).wait();
  const id2 = await asAdmin.governor.proposalCount();
  await (await asAlice.governor.castVote(id2, 1)).wait();
  await provider.send("evm_increaseTime", [deployment.votingPeriod]);
  await provider.send("evm_mine", []);
  await expectRejected("execute a payout larger than the free balance", explain, () =>
    asAdmin.governor.execute(id2)
  );

  console.log("\nTreasury now:");
  console.log(`  balance   ${fmt(await provider.getBalance(a.DAOTreasury))} ETH`);
  console.log(`  available ${fmt(await asAdmin.treasury.availableBalance())} ETH`);
  console.log(`  reserved  ${fmt(await asAdmin.treasury.totalReserved())} ETH`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
