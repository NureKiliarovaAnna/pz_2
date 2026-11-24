const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const eth = ethers.parseEther;
const fmt = ethers.formatEther;
const PERIOD = 60;
const FAKE_PROPOSAL_ID = 999n;
const AMOUNT = eth("1");

/// Deploys DAOToken, the chosen treasury and a real DAOGovernor,
/// binds them through setGovernor() and funds the treasury with 1 ETH.
async function deploySystem(treasuryName) {
  const [admin, guardian, attackerAccount] = await ethers.getSigners();

  const token = await ethers.deployContract("DAOToken", [admin.address]);
  const treasury = await ethers.deployContract(treasuryName, [
    admin.address,
    guardian.address,
  ]);
  const governor = await ethers.deployContract("DAOGovernor", [
    token.target,
    treasury.target,
    admin.address,
    admin.address,
    guardian.address,
    PERIOD,
  ]);

  await treasury.setGovernor(governor.target);
  await treasury.deposit({ value: AMOUNT });

  const attacker = await ethers.deployContract(
    "PayoutAttacker",
    [treasury.target],
    attackerAccount
  );

  return { admin, guardian, attackerAccount, token, treasury, governor, attacker };
}

const vulnerableFixture = () => deploySystem("VulnerableDAOTreasury");
const protectedFixture = () => deploySystem("DAOTreasury");

async function balances(f) {
  return {
    treasury: await ethers.provider.getBalance(f.treasury.target),
    attacker: await ethers.provider.getBalance(f.attacker.target),
  };
}

function report(label, before, after) {
  console.log(
    `      [${label}] treasury: ${fmt(before.treasury)} -> ${fmt(after.treasury)} ETH; ` +
      `attacker: ${fmt(before.attacker)} -> ${fmt(after.attacker)} ETH`
  );
}

async function expectAttackerHasNoRoles(f) {
  const account = f.attackerAccount.address;

  for (const contract of [f.treasury, f.governor]) {
    expect(await contract.hasRole(ethers.ZeroHash, account)).to.equal(false);
    expect(
      await contract.hasRole(await contract.GUARDIAN_ROLE(), account)
    ).to.equal(false);
  }

  expect(
    await f.governor.hasRole(await f.governor.PROPOSER_ROLE(), account)
  ).to.equal(false);
}

describe("Security: unauthorized payout reservation", function () {
  it("A: drains the vulnerable copy without any proposal or vote", async function () {
    const f = await loadFixture(vulnerableFixture);
    await expectAttackerHasNoRoles(f);

    expect(await f.treasury.governor()).to.equal(f.governor.target);
    expect(await f.governor.proposalCount()).to.equal(0n);

    const before = await balances(f);
    expect(before.treasury).to.equal(AMOUNT);
    expect(before.attacker).to.equal(0n);

    const tx = f.attacker
      .connect(f.attackerAccount)
      .attack(FAKE_PROPOSAL_ID, AMOUNT);

    await expect(tx)
      .to.emit(f.treasury, "PayoutReserved")
      .withArgs(FAKE_PROPOSAL_ID, f.attacker.target, AMOUNT)
      .and.to.emit(f.treasury, "Withdrawn")
      .withArgs(f.attacker.target, AMOUNT)
      .and.to.emit(f.attacker, "AttackCompleted")
      .withArgs(FAKE_PROPOSAL_ID, AMOUNT);

    await expect(tx).to.changeEtherBalances(
      [f.treasury, f.attacker],
      [-AMOUNT, AMOUNT]
    );

    const after = await balances(f);
    report("vulnerable", before, after);

    expect(after.treasury).to.equal(0n);
    expect(after.attacker).to.equal(AMOUNT);

    expect(await f.governor.proposalCount()).to.equal(0n);
    await expect(f.governor.getProposal(FAKE_PROPOSAL_ID))
      .to.be.revertedWithCustomError(f.governor, "UnknownProposal")
      .withArgs(FAKE_PROPOSAL_ID);

    expect(await f.treasury.claimable(f.attacker.target)).to.equal(0n);
    expect(await f.treasury.totalReserved()).to.equal(0n);
    expect(await f.treasury.payoutReserved(FAKE_PROPOSAL_ID)).to.equal(true);
  });

  it("B: the protected DAOTreasury rejects the same attack", async function () {
    const f = await loadFixture(protectedFixture);
    await expectAttackerHasNoRoles(f);

    expect(await f.treasury.governor()).to.equal(f.governor.target);

    const before = await balances(f);
    expect(before.treasury).to.equal(AMOUNT);
    expect(before.attacker).to.equal(0n);

    await expect(
      f.attacker.connect(f.attackerAccount).attack(FAKE_PROPOSAL_ID, AMOUNT)
    )
      .to.be.revertedWithCustomError(f.treasury, "UnauthorizedGovernor")
      .withArgs(f.attacker.target);

    const after = await balances(f);
    report("protected", before, after);

    expect(after.treasury).to.equal(AMOUNT);
    expect(after.attacker).to.equal(before.attacker);

    expect(await f.governor.proposalCount()).to.equal(0n);
    expect(await f.treasury.claimable(f.attacker.target)).to.equal(0n);
    expect(await f.treasury.totalReserved()).to.equal(0n);
    expect(await f.treasury.payoutReserved(FAKE_PROPOSAL_ID)).to.equal(false);
    expect(await f.treasury.availableBalance()).to.equal(AMOUNT);
  });
});

describe("Security: VulnerableDAOTreasury keeps every other check", function () {
  it("validates deposits and withdrawals like DAOTreasury", async function () {
    const f = await loadFixture(vulnerableFixture);

    await expect(
      f.attackerAccount.sendTransaction({ to: f.treasury.target, value: 5n })
    )
      .to.emit(f.treasury, "Deposited")
      .withArgs(f.attackerAccount.address, 5n);

    await expect(
      f.treasury.deposit({ value: 0n })
    ).to.be.revertedWithCustomError(f.treasury, "ZeroAmount");

    await expect(
      f.treasury.connect(f.attackerAccount).withdraw()
    ).to.be.revertedWithCustomError(f.treasury, "NothingToWithdraw");
  });

  it("is still stopped by the guardian pause", async function () {
    const f = await loadFixture(vulnerableFixture);

    await f.treasury.connect(f.guardian).pause();

    await expect(
      f.attacker.connect(f.attackerAccount).attack(FAKE_PROPOSAL_ID, AMOUNT)
    ).to.be.revertedWithCustomError(f.treasury, "EnforcedPause");

    for (const action of [
      () => f.treasury.deposit({ value: 1n }),
      () => f.admin.sendTransaction({ to: f.treasury.target, value: 1n }),
      () => f.treasury.withdraw(),
    ]) {
      await expect(action()).to.be.revertedWithCustomError(
        f.treasury,
        "EnforcedPause"
      );
    }

    expect(
      await ethers.provider.getBalance(f.treasury.target)
    ).to.equal(AMOUNT);
  });
});
