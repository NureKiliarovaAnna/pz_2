const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  loadFixture,
  time,
  mine,
} = require("@nomicfoundation/hardhat-network-helpers");

const eth = ethers.parseEther;
const PERIOD = 60;
const TEXT = "Fund the DAO website";
const MIN_PERIOD = 60n;
const MAX_PERIOD = 30n * 24n * 60n * 60n;

// Proposal states.
const ACTIVE = 1n;
const DEFEATED = 2n;
const SUCCEEDED = 3n;

async function expectDenied(action, contract, account, role) {
  await expect(action)
    .to.be.revertedWithCustomError(
      contract,
      "AccessControlUnauthorizedAccount"
    )
    .withArgs(account.address, role);
}

/* ------------------------------------------------------------------ */
/* Full system: token + treasury + governor                           */
/* ------------------------------------------------------------------ */

async function systemFixture() {
  const [admin, alice, bob, guardian, outsider, carol] =
    await ethers.getSigners();

  const token = await ethers.deployContract("DAOToken", [admin.address]);
  const treasury = await ethers.deployContract("DAOTreasury", [
    admin.address,
    guardian.address,
  ]);
  const Governor = await ethers.getContractFactory("DAOGovernor");
  const governor = await Governor.deploy(
    token.target,
    treasury.target,
    admin.address,
    admin.address,
    guardian.address,
    PERIOD
  );

  await treasury.setGovernor(governor.target);
  await treasury.deposit({ value: eth("1") });

  await token.transfer(alice.address, eth("600"));
  await token.transfer(bob.address, eth("400"));
  await token.connect(alice).delegate(alice.address);
  await token.connect(bob).delegate(bob.address);

  return {
    admin, alice, bob, guardian, outsider, carol,
    token, treasury, Governor, governor,
  };
}

async function activeFixture() {
  const f = await systemFixture();
  await f.governor.createProposal(f.bob.address, eth("0.1"), TEXT);
  await mine();
  const deadline = (await f.governor.getProposal(1)).deadline;
  return { ...f, id: 1n, deadline };
}

async function votedFixture() {
  const f = await activeFixture();
  await f.governor.connect(f.alice).castVote(f.id, 1);
  return f;
}

/* ------------------------------------------------------------------ */
/* DAOGovernor constructor                                            */
/* ------------------------------------------------------------------ */

describe("DAOGovernor constructor", function () {
  async function args(f, overrides = {}) {
    const a = {
      token: f.token.target,
      treasury: f.treasury.target,
      admin: f.admin.address,
      proposer: f.admin.address,
      guardian: f.guardian.address,
      period: PERIOD,
      ...overrides,
    };
    return [a.token, a.treasury, a.admin, a.proposer, a.guardian, a.period];
  }

  for (const role of ["admin", "proposer", "guardian"]) {
    it(`rejects a zero ${role} address`, async function () {
      const f = await loadFixture(systemFixture);

      await expect(
        f.Governor.deploy(
          ...(await args(f, { [role]: ethers.ZeroAddress }))
        )
      ).to.be.revertedWithCustomError(f.governor, "InvalidAddress");
    });
  }

  for (const field of ["token", "treasury"]) {
    it(`rejects a zero ${field} address`, async function () {
      const f = await loadFixture(systemFixture);

      await expect(
        f.Governor.deploy(
          ...(await args(f, { [field]: ethers.ZeroAddress }))
        )
      )
        .to.be.revertedWithCustomError(f.governor, "InvalidContractAddress")
        .withArgs(ethers.ZeroAddress);
    });

    it(`rejects a ${field} address without code`, async function () {
      const f = await loadFixture(systemFixture);

      await expect(
        f.Governor.deploy(
          ...(await args(f, { [field]: f.outsider.address }))
        )
      )
        .to.be.revertedWithCustomError(f.governor, "InvalidContractAddress")
        .withArgs(f.outsider.address);
    });
  }

  for (const period of [0n, MIN_PERIOD - 1n, MAX_PERIOD + 1n]) {
    it(`rejects a voting period of ${period} seconds`, async function () {
      const f = await loadFixture(systemFixture);

      await expect(f.Governor.deploy(...(await args(f, { period }))))
        .to.be.revertedWithCustomError(f.governor, "InvalidVotingPeriod")
        .withArgs(period);
    });
  }

  for (const period of [MIN_PERIOD, MAX_PERIOD]) {
    it(`accepts the boundary voting period of ${period} seconds`, async function () {
      const f = await loadFixture(systemFixture);

      const governor = await f.Governor.deploy(
        ...(await args(f, { period }))
      );

      expect(await governor.votingPeriod()).to.equal(period);
      expect(await governor.MIN_VOTING_PERIOD()).to.equal(MIN_PERIOD);
      expect(await governor.MAX_VOTING_PERIOD()).to.equal(MAX_PERIOD);

      const tx = await governor.createProposal(f.bob.address, 1n, TEXT);
      const block = await ethers.provider.getBlock(
        (await tx.wait()).blockNumber
      );

      expect((await governor.getProposal(1)).deadline).to.equal(
        BigInt(block.timestamp) + period
      );
    });
  }
});

/* ------------------------------------------------------------------ */
/* Treasury logic, checked on both the main and the vulnerable copy   */
/* ------------------------------------------------------------------ */

for (const treasuryName of ["DAOTreasury", "VulnerableDAOTreasury"]) {
  describe(`${treasuryName} edge cases`, function () {
    /// Treasury bound to a test-only TreasuryCaller acting as governor.
    async function treasuryFixture() {
      const [admin, guardian, bob, carol, outsider] =
        await ethers.getSigners();

      const Treasury = await ethers.getContractFactory(treasuryName);
      const treasury = await Treasury.deploy(admin.address, guardian.address);
      const caller = await ethers.deployContract("TreasuryCaller");
      const rejecting = await ethers.deployContract("RejectingRecipient");

      await treasury.setGovernor(caller.target);
      await treasury.deposit({ value: eth("1") });

      const reserve = (id, recipient, amount) =>
        caller.reserve(treasury.target, id, recipient, amount);

      return {
        admin, guardian, bob, carol, outsider,
        Treasury, treasury, caller, rejecting, reserve,
      };
    }

    async function unboundFixture() {
      const [admin, guardian, , , outsider] = await ethers.getSigners();
      const Treasury = await ethers.getContractFactory(treasuryName);
      const treasury = await Treasury.deploy(admin.address, guardian.address);
      const caller = await ethers.deployContract("TreasuryCaller");
      return { admin, guardian, outsider, Treasury, treasury, caller };
    }

    describe("constructor", function () {
      it("rejects a zero admin or guardian", async function () {
        const f = await loadFixture(unboundFixture);

        for (const [admin, guardian] of [
          [ethers.ZeroAddress, f.guardian.address],
          [f.admin.address, ethers.ZeroAddress],
        ]) {
          await expect(
            f.Treasury.deploy(admin, guardian)
          ).to.be.revertedWithCustomError(f.treasury, "InvalidAddress");
        }
      });

      it("assigns the admin and guardian roles", async function () {
        const f = await loadFixture(unboundFixture);

        expect(
          await f.treasury.hasRole(ethers.ZeroHash, f.admin.address)
        ).to.equal(true);
        expect(
          await f.treasury.hasRole(
            await f.treasury.GUARDIAN_ROLE(),
            f.guardian.address
          )
        ).to.equal(true);
        expect(await f.treasury.governor()).to.equal(ethers.ZeroAddress);
      });
    });

    describe("setGovernor", function () {
      it("rejects the zero address", async function () {
        const f = await loadFixture(unboundFixture);

        await expect(
          f.treasury.setGovernor(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(f.treasury, "InvalidAddress");
      });

      it("rejects a regular account instead of a contract", async function () {
        const f = await loadFixture(unboundFixture);

        await expect(
          f.treasury.setGovernor(f.outsider.address)
        ).to.be.revertedWithCustomError(f.treasury, "InvalidGovernor");

        expect(await f.treasury.governor()).to.equal(ethers.ZeroAddress);
      });

      it("rejects callers without the admin role, including the guardian", async function () {
        const f = await loadFixture(unboundFixture);

        await expectDenied(
          f.treasury.connect(f.guardian).setGovernor(f.caller.target),
          f.treasury,
          f.guardian,
          ethers.ZeroHash
        );
      });

      it("binds once, emits GovernorSet and cannot be repeated", async function () {
        const f = await loadFixture(unboundFixture);

        await expect(f.treasury.setGovernor(f.caller.target))
          .to.emit(f.treasury, "GovernorSet")
          .withArgs(f.caller.target);

        expect(await f.treasury.governor()).to.equal(f.caller.target);

        for (const next of [f.caller.target, f.treasury.target]) {
          await expect(
            f.treasury.setGovernor(next)
          ).to.be.revertedWithCustomError(f.treasury, "GovernorAlreadySet");
        }
      });
    });

    describe("reservePayout", function () {
      it("rejects a zero recipient", async function () {
        const f = await loadFixture(treasuryFixture);

        await expect(
          f.reserve(1, ethers.ZeroAddress, 1n)
        ).to.be.revertedWithCustomError(f.treasury, "InvalidAddress");
      });

      it("rejects a zero amount", async function () {
        const f = await loadFixture(treasuryFixture);

        await expect(
          f.reserve(1, f.bob.address, 0n)
        ).to.be.revertedWithCustomError(f.treasury, "ZeroAmount");
      });

      it("rejects a repeated proposalId", async function () {
        const f = await loadFixture(treasuryFixture);

        await f.reserve(7, f.bob.address, eth("0.1"));

        await expect(f.reserve(7, f.carol.address, eth("0.1")))
          .to.be.revertedWithCustomError(f.treasury, "PayoutAlreadyReserved")
          .withArgs(7n);

        expect(await f.treasury.claimable(f.carol.address)).to.equal(0n);
        expect(await f.treasury.totalReserved()).to.equal(eth("0.1"));
      });

      it("rejects an amount above the unreserved balance by one wei", async function () {
        const f = await loadFixture(treasuryFixture);

        await expect(f.reserve(1, f.bob.address, eth("1") + 1n))
          .to.be.revertedWithCustomError(
            f.treasury,
            "InsufficientAvailableFunds"
          )
          .withArgs(eth("1"), eth("1") + 1n);

        expect(await f.treasury.payoutReserved(1)).to.equal(false);
      });

      it("reserves exactly the whole available balance", async function () {
        const f = await loadFixture(treasuryFixture);

        await expect(f.reserve(1, f.bob.address, eth("1")))
          .to.emit(f.treasury, "PayoutReserved")
          .withArgs(1n, f.bob.address, eth("1"));

        expect(await f.treasury.availableBalance()).to.equal(0n);
      });

      it("accumulates several approved payouts for one recipient", async function () {
        const f = await loadFixture(treasuryFixture);

        await f.reserve(1, f.bob.address, eth("0.1"));
        await f.reserve(2, f.bob.address, eth("0.25"));
        await f.reserve(3, f.carol.address, eth("0.15"));

        expect(await f.treasury.claimable(f.bob.address)).to.equal(eth("0.35"));
        expect(await f.treasury.claimable(f.carol.address)).to.equal(eth("0.15"));
        expect(await f.treasury.totalReserved()).to.equal(eth("0.5"));
        expect(await f.treasury.availableBalance()).to.equal(eth("0.5"));

        await expect(f.treasury.connect(f.bob).withdraw())
          .to.emit(f.treasury, "Withdrawn")
          .withArgs(f.bob.address, eth("0.35"));

        expect(await f.treasury.totalReserved()).to.equal(eth("0.15"));
      });

      it("cannot reserve the same balance twice", async function () {
        const f = await loadFixture(treasuryFixture);

        await f.reserve(1, f.bob.address, eth("0.6"));

        expect(
          await ethers.provider.getBalance(f.treasury.target)
        ).to.equal(eth("1"));

        await expect(f.reserve(2, f.carol.address, eth("0.5")))
          .to.be.revertedWithCustomError(
            f.treasury,
            "InsufficientAvailableFunds"
          )
          .withArgs(eth("0.4"), eth("0.5"));

        await f.reserve(2, f.carol.address, eth("0.4"));
        expect(await f.treasury.availableBalance()).to.equal(0n);
        expect(await f.treasury.totalReserved()).to.equal(eth("1"));
      });

      it("makes new deposits available for further reservations", async function () {
        const f = await loadFixture(treasuryFixture);

        await f.reserve(1, f.bob.address, eth("1"));
        await f.treasury.connect(f.outsider).deposit({ value: eth("0.3") });

        expect(await f.treasury.availableBalance()).to.equal(eth("0.3"));
        await f.reserve(2, f.carol.address, eth("0.3"));
      });

      it("is blocked while paused", async function () {
        const f = await loadFixture(treasuryFixture);

        await f.treasury.connect(f.guardian).pause();

        await expect(
          f.reserve(1, f.bob.address, 1n)
        ).to.be.revertedWithCustomError(f.treasury, "EnforcedPause");
      });
    });

    describe("withdraw to a recipient that rejects ETH", function () {
      it("reverts and keeps the claim and accounting intact", async function () {
        const f = await loadFixture(treasuryFixture);

        await f.reserve(1, f.rejecting.target, eth("0.3"));

        await expect(
          f.rejecting.withdrawFrom(f.treasury.target)
        ).to.be.revertedWithCustomError(f.treasury, "TransferFailed");

        expect(await f.treasury.claimable(f.rejecting.target)).to.equal(eth("0.3"));
        expect(await f.treasury.totalReserved()).to.equal(eth("0.3"));
        expect(await f.treasury.availableBalance()).to.equal(eth("0.7"));
        expect(
          await ethers.provider.getBalance(f.treasury.target)
        ).to.equal(eth("1"));
        expect(
          await ethers.provider.getBalance(f.rejecting.target)
        ).to.equal(0n);

        await f.rejecting.setAcceptPayments(true);

        await expect(
          f.rejecting.withdrawFrom(f.treasury.target)
        ).to.changeEtherBalances(
          [f.treasury, f.rejecting],
          [-eth("0.3"), eth("0.3")]
        );

        expect(await f.treasury.claimable(f.rejecting.target)).to.equal(0n);
        expect(await f.treasury.totalReserved()).to.equal(0n);
      });

      it("does not block another recipient from withdrawing", async function () {
        const f = await loadFixture(treasuryFixture);

        await f.reserve(1, f.rejecting.target, eth("0.3"));
        await f.reserve(2, f.bob.address, eth("0.2"));

        await expect(
          f.rejecting.withdrawFrom(f.treasury.target)
        ).to.be.revertedWithCustomError(f.treasury, "TransferFailed");

        await expect(
          f.treasury.connect(f.bob).withdraw()
        ).to.changeEtherBalances(
          [f.treasury, f.bob],
          [-eth("0.2"), eth("0.2")]
        );

        expect(await f.treasury.claimable(f.bob.address)).to.equal(0n);
        expect(await f.treasury.claimable(f.rejecting.target)).to.equal(eth("0.3"));
        expect(await f.treasury.totalReserved()).to.equal(eth("0.3"));
      });
    });

    describe("roles and pause", function () {
      it("lets the admin grant and revoke the guardian role", async function () {
        const f = await loadFixture(treasuryFixture);
        const role = await f.treasury.GUARDIAN_ROLE();

        await expect(f.treasury.grantRole(role, f.carol.address))
          .to.emit(f.treasury, "RoleGranted")
          .withArgs(role, f.carol.address, f.admin.address);

        await expect(f.treasury.connect(f.carol).pause())
          .to.emit(f.treasury, "Paused")
          .withArgs(f.carol.address);

        await expectDenied(
          f.treasury.connect(f.carol).unpause(),
          f.treasury,
          f.carol,
          ethers.ZeroHash
        );

        await f.treasury.unpause();

        await expect(f.treasury.revokeRole(role, f.carol.address))
          .to.emit(f.treasury, "RoleRevoked")
          .withArgs(role, f.carol.address, f.admin.address);

        await expectDenied(
          f.treasury.connect(f.carol).pause(),
          f.treasury,
          f.carol,
          role
        );
      });

      it("does not let the guardian grant roles", async function () {
        const f = await loadFixture(treasuryFixture);

        await expectDenied(
          f.treasury
            .connect(f.guardian)
            .grantRole(await f.treasury.GUARDIAN_ROLE(), f.carol.address),
          f.treasury,
          f.guardian,
          ethers.ZeroHash
        );
      });

      it("rejects double pause and unpause without pause", async function () {
        const f = await loadFixture(treasuryFixture);

        await expect(
          f.treasury.unpause()
        ).to.be.revertedWithCustomError(f.treasury, "ExpectedPause");

        await f.treasury.connect(f.guardian).pause();
        expect(await f.treasury.paused()).to.equal(true);

        await expect(
          f.treasury.connect(f.guardian).pause()
        ).to.be.revertedWithCustomError(f.treasury, "EnforcedPause");
      });

      it("keeps claims during a pause and pays them after unpause", async function () {
        const f = await loadFixture(treasuryFixture);

        await f.reserve(1, f.bob.address, eth("0.4"));
        await f.treasury.connect(f.guardian).pause();

        await expect(
          f.treasury.connect(f.bob).withdraw()
        ).to.be.revertedWithCustomError(f.treasury, "EnforcedPause");

        expect(await f.treasury.claimable(f.bob.address)).to.equal(eth("0.4"));
        expect(await f.treasury.availableBalance()).to.equal(eth("0.6"));

        await expect(f.treasury.unpause())
          .to.emit(f.treasury, "Unpaused")
          .withArgs(f.admin.address);

        await expect(
          f.treasury.connect(f.bob).withdraw()
        ).to.changeEtherBalance(f.bob, eth("0.4"));
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* DAOGovernor: roles and pause                                       */
/* ------------------------------------------------------------------ */

describe("DAOGovernor roles and pause", function () {
  it("lets the admin grant and revoke the proposer role", async function () {
    const f = await loadFixture(systemFixture);
    const role = await f.governor.PROPOSER_ROLE();

    await expect(f.governor.grantRole(role, f.carol.address))
      .to.emit(f.governor, "RoleGranted")
      .withArgs(role, f.carol.address, f.admin.address);

    await expect(
      f.governor.connect(f.carol).createProposal(f.bob.address, 1n, TEXT)
    )
      .to.emit(f.governor, "ProposalCreated");

    expect((await f.governor.getProposal(1)).proposer).to.equal(f.carol.address);

    await expect(f.governor.revokeRole(role, f.carol.address))
      .to.emit(f.governor, "RoleRevoked")
      .withArgs(role, f.carol.address, f.admin.address);

    await expectDenied(
      f.governor.connect(f.carol).createProposal(f.bob.address, 1n, TEXT),
      f.governor,
      f.carol,
      role
    );
  });

  it("does not let the guardian unpause or the proposer pause", async function () {
    const f = await loadFixture(systemFixture);

    await f.governor.connect(f.guardian).pause();

    await expectDenied(
      f.governor.connect(f.guardian).unpause(),
      f.governor,
      f.guardian,
      ethers.ZeroHash
    );

    await f.governor.unpause();

    // admin holds PROPOSER_ROLE but not GUARDIAN_ROLE
    await expectDenied(
      f.governor.connect(f.admin).pause(),
      f.governor,
      f.admin,
      await f.governor.GUARDIAN_ROLE()
    );
  });

  it("rejects double pause and unpause without pause", async function () {
    const f = await loadFixture(systemFixture);

    await expect(
      f.governor.unpause()
    ).to.be.revertedWithCustomError(f.governor, "ExpectedPause");

    await f.governor.connect(f.guardian).pause();

    await expect(
      f.governor.connect(f.guardian).pause()
    ).to.be.revertedWithCustomError(f.governor, "EnforcedPause");
  });

  it("keeps read-only functions available while paused", async function () {
    const f = await loadFixture(votedFixture);

    await f.governor.connect(f.guardian).pause();

    expect(await f.governor.state(f.id)).to.equal(ACTIVE);
    expect(await f.governor.quorum(f.id)).to.equal(eth("200"));
    expect((await f.governor.getProposals(0, 1)).length).to.equal(1);
  });
});

/* ------------------------------------------------------------------ */
/* DAOGovernor: deadlines                                             */
/* ------------------------------------------------------------------ */

describe("DAOGovernor deadlines", function () {
  it("stays Active at deadline - 1 and ends exactly at the deadline", async function () {
    const f = await loadFixture(votedFixture);

    await time.setNextBlockTimestamp(f.deadline - 1n);
    await mine();
    expect(await f.governor.state(f.id)).to.equal(ACTIVE);

    await time.setNextBlockTimestamp(f.deadline);
    await mine();
    expect(await f.governor.state(f.id)).to.equal(SUCCEEDED);
  });

  it("rejects execution in the last second before the deadline", async function () {
    const f = await loadFixture(votedFixture);

    await time.setNextBlockTimestamp(f.deadline - 1n);

    await expect(f.governor.execute(f.id))
      .to.be.revertedWithCustomError(f.governor, "UnexpectedProposalState")
      .withArgs(f.id, ACTIVE, SUCCEEDED);
  });

  for (const secondsAfter of [0n, 1n]) {
    it(`allows execution at deadline + ${secondsAfter} seconds`, async function () {
      const f = await loadFixture(votedFixture);

      await time.setNextBlockTimestamp(f.deadline + secondsAfter);

      await expect(f.governor.execute(f.id))
        .to.emit(f.governor, "ProposalExecuted")
        .withArgs(f.id, f.admin.address, f.bob.address, eth("0.1"));
    });
  }

  it("does not extend the deadline during a pause", async function () {
    const f = await loadFixture(activeFixture);

    await f.governor.connect(f.guardian).pause();
    await time.increaseTo(f.deadline);
    await f.governor.unpause();

    expect((await f.governor.getProposal(f.id)).deadline).to.equal(f.deadline);
    expect(await f.governor.state(f.id)).to.equal(DEFEATED);

    await expect(f.governor.connect(f.alice).castVote(f.id, 1))
      .to.be.revertedWithCustomError(f.governor, "UnexpectedProposalState")
      .withArgs(f.id, DEFEATED, ACTIVE);
  });

  it("keeps votes cast before a pause that outlasts the deadline", async function () {
    const f = await loadFixture(votedFixture);

    await f.governor.connect(f.guardian).pause();
    await time.increaseTo(f.deadline + 3600n);

    await expect(f.governor.execute(f.id))
      .to.be.revertedWithCustomError(f.governor, "EnforcedPause");

    await f.governor.unpause();

    expect(await f.governor.state(f.id)).to.equal(SUCCEEDED);
    await f.governor.execute(f.id);
    expect(await f.treasury.claimable(f.bob.address)).to.equal(eth("0.1"));
  });
});

/* ------------------------------------------------------------------ */
/* DAOGovernor: snapshots                                             */
/* ------------------------------------------------------------------ */

describe("DAOGovernor snapshots", function () {
  it("ignores re-delegation after the snapshot", async function () {
    const f = await loadFixture(activeFixture);

    await f.token.connect(f.alice).delegate(f.bob.address);
    expect(await f.token.getVotes(f.bob.address)).to.equal(eth("1000"));

    await expect(f.governor.connect(f.bob).castVote(f.id, 0))
      .to.emit(f.governor, "VoteCast")
      .withArgs(f.id, f.bob.address, 0, eth("400"));

    await expect(f.governor.connect(f.alice).castVote(f.id, 1))
      .to.emit(f.governor, "VoteCast")
      .withArgs(f.id, f.alice.address, 1, eth("600"));

    const p = await f.governor.getProposal(f.id);
    expect(p.forVotes + p.againstVotes + p.abstainVotes).to.equal(
      await f.token.totalSupply()
    );
  });

  it("counts tokens delegated before the snapshot", async function () {
    const f = await loadFixture(systemFixture);

    await f.token.connect(f.alice).transfer(f.carol.address, eth("50"));
    await f.token.connect(f.carol).delegate(f.carol.address);

    await f.governor.createProposal(f.bob.address, 1n, TEXT);
    await mine();

    await expect(f.governor.connect(f.carol).castVote(1, 2))
      .to.emit(f.governor, "VoteCast")
      .withArgs(1n, f.carol.address, 2, eth("50"));

    await expect(f.governor.connect(f.alice).castVote(1, 1))
      .to.emit(f.governor, "VoteCast")
      .withArgs(1n, f.alice.address, 1, eth("550"));
  });

  it("uses a separate snapshot for each proposal", async function () {
    const f = await loadFixture(activeFixture);

    await f.token.connect(f.alice).transfer(f.bob.address, eth("600"));
    await f.governor.createProposal(f.bob.address, 1n, TEXT);
    await mine();

    await f.governor.connect(f.alice).castVote(1, 1);
    await expect(f.governor.connect(f.alice).castVote(2, 1))
      .to.be.revertedWithCustomError(f.governor, "NoVotingPower")
      .withArgs(f.alice.address);

    await expect(f.governor.connect(f.bob).castVote(2, 1))
      .to.emit(f.governor, "VoteCast")
      .withArgs(2n, f.bob.address, 1, eth("1000"));
  });
});

/* ------------------------------------------------------------------ */
/* DAOGovernor: quorum, tie, abstain                                  */
/* ------------------------------------------------------------------ */

describe("DAOGovernor quorum and outcomes", function () {
  /// Gives alice `aliceAmount`, bob the rest, creates a proposal,
  /// casts the votes and moves past the deadline.
  async function outcome(aliceAmount, aliceSupport, bobSupport) {
    const f = await loadFixture(systemFixture);
    const transfer = eth("600") - aliceAmount;

    if (transfer > 0n) {
      await f.token.connect(f.alice).transfer(f.bob.address, transfer);
    }

    await f.governor.createProposal(f.bob.address, 1n, TEXT);

    if (aliceSupport !== null) {
      await f.governor.connect(f.alice).castVote(1, aliceSupport);
    }
    if (bobSupport !== null) {
      await f.governor.connect(f.bob).castVote(1, bobSupport);
    }

    await time.increaseTo((await f.governor.getProposal(1)).deadline);
    return { f, state: await f.governor.state(1) };
  }

  it("is defeated one wei below quorum", async function () {
    const { state } = await outcome(eth("200") - 1n, 1, null);
    expect(state).to.equal(DEFEATED);
  });

  it("is defeated with abstentions only, even above quorum", async function () {
    const { state, f } = await outcome(eth("600"), 2, 2);
    expect(state).to.equal(DEFEATED);
    expect((await f.governor.getProposal(1)).abstainVotes).to.equal(eth("1000"));
  });

  it("succeeds when for exceeds against by one wei", async function () {
    const { state } = await outcome(eth("500") + 1n, 1, 0);
    expect(state).to.equal(SUCCEEDED);
  });

  it("is defeated on a tie even with abstentions meeting quorum", async function () {
    const f = await loadFixture(systemFixture);

    await f.token.connect(f.alice).transfer(f.carol.address, eth("200"));
    await f.token.connect(f.carol).delegate(f.carol.address);
    // alice 400, bob 400, carol 200
    await f.governor.createProposal(f.bob.address, 1n, TEXT);

    await f.governor.connect(f.alice).castVote(1, 1);
    await f.governor.connect(f.bob).castVote(1, 0);
    await f.governor.connect(f.carol).castVote(1, 2);

    await time.increaseTo((await f.governor.getProposal(1)).deadline);
    expect(await f.governor.state(1)).to.equal(DEFEATED);

    await expect(f.governor.execute(1))
      .to.be.revertedWithCustomError(f.governor, "UnexpectedProposalState")
      .withArgs(1n, DEFEATED, SUCCEEDED);
  });

  it("is defeated when nobody votes", async function () {
    const { state } = await outcome(eth("600"), null, null);
    expect(state).to.equal(DEFEATED);
  });
});

/* ------------------------------------------------------------------ */
/* DAOGovernor: unknown proposals and pagination                      */
/* ------------------------------------------------------------------ */

describe("DAOGovernor unknown proposals and pagination", function () {
  for (const id of [0n, 2n, ethers.MaxUint256]) {
    it(`rejects every operation on unknown proposal ${id}`, async function () {
      const f = await loadFixture(activeFixture);

      const calls = [
        () => f.governor.state(id),
        () => f.governor.quorum(id),
        () => f.governor.connect(f.alice).castVote(id, 1),
        () => f.governor.execute(id),
      ];

      for (const call of calls) {
        await expect(call())
          .to.be.revertedWithCustomError(f.governor, "UnknownProposal")
          .withArgs(id);
      }
    });
  }

  it("returns an empty page when there are no proposals", async function () {
    const f = await loadFixture(systemFixture);

    expect(await f.governor.proposalCount()).to.equal(0n);
    expect((await f.governor.getProposals(0, 1)).length).to.equal(0);
    expect((await f.governor.getProposals(0, 50)).length).to.equal(0);
  });

  it("returns middle pages, the maximum page size and huge offsets", async function () {
    const f = await loadFixture(systemFixture);

    for (let i = 1; i <= 4; i++) {
      await f.governor.createProposal(f.bob.address, BigInt(i), `Proposal ${i}`);
    }

    const middle = await f.governor.getProposals(1, 2);
    expect(middle.map((p) => p.description)).to.deep.equal([
      "Proposal 2",
      "Proposal 3",
    ]);
    expect(middle[1].amount).to.equal(3n);

    const all = await f.governor.getProposals(0, 50);
    expect(all.length).to.equal(4);
    expect(all[3].description).to.equal("Proposal 4");

    expect((await f.governor.getProposals(4, 1)).length).to.equal(0);
    expect(
      (await f.governor.getProposals(ethers.MaxUint256, 50)).length
    ).to.equal(0);
  });
});
