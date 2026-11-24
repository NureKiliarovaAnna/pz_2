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

async function deployDAOFixture() {
  const [admin, alice, bob, guardian, outsider] =
    await ethers.getSigners();

  const Token = await ethers.getContractFactory("DAOToken");
  const Treasury = await ethers.getContractFactory("DAOTreasury");
  const Governor = await ethers.getContractFactory("DAOGovernor");

  const token = await Token.deploy(admin.address);
  await token.waitForDeployment();

  const treasury = await Treasury.deploy(
    admin.address,
    guardian.address
  );
  await treasury.waitForDeployment();

  const governor = await Governor.deploy(
    token.target,
    treasury.target,
    admin.address,
    admin.address,
    guardian.address,
    PERIOD
  );
  await governor.waitForDeployment();

  await treasury.setGovernor(governor.target);
  await treasury.deposit({ value: eth("1") });

  await token.transfer(alice.address, eth("600"));
  await token.transfer(bob.address, eth("400"));

  await token.connect(alice).delegate(alice.address);
  await token.connect(bob).delegate(bob.address);

  return {
    admin,
    alice,
    bob,
    guardian,
    outsider,
    Token,
    Treasury,
    Governor,
    token,
    treasury,
    governor,
  };
}

async function proposalFixture() {
  const f = await deployDAOFixture();

  await f.governor.createProposal(
    f.bob.address,
    eth("0.1"),
    TEXT
  );

  return { ...f, id: 1n };
}

async function activeFixture() {
  const f = await proposalFixture();
  await mine();
  return f;
}

async function approvedFixture() {
  const f = await activeFixture();

  await f.governor.connect(f.alice).castVote(f.id, 1);

  const proposal = await f.governor.getProposal(f.id);
  await time.increaseTo(proposal.deadline);

  return f;
}

async function expectDenied(action, contract, account, role) {
  await expect(action)
    .to.be.revertedWithCustomError(
      contract,
      "AccessControlUnauthorizedAccount"
    )
    .withArgs(account.address, role);
}

describe("DAOToken", function () {
  it("has the expected metadata and fixed supply", async function () {
    const f = await loadFixture(deployDAOFixture);

    expect(await f.token.name()).to.equal("DAO Vote");
    expect(await f.token.symbol()).to.equal("DVT");
    expect(await f.token.decimals()).to.equal(18n);
    expect(await f.token.totalSupply()).to.equal(eth("1000"));

    expect(
      await f.token.balanceOf(f.alice.address)
    ).to.equal(eth("600"));

    expect(
      await f.token.balanceOf(f.bob.address)
    ).to.equal(eth("400"));
  });

  it("rejects a zero initial holder", async function () {
    const f = await loadFixture(deployDAOFixture);

    await expect(f.Token.deploy(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(
        f.token,
        "InvalidInitialHolder"
      );
  });

  it("activates votes only after delegation", async function () {
    const f = await loadFixture(deployDAOFixture);

    await f.token
      .connect(f.alice)
      .transfer(f.outsider.address, eth("100"));

    expect(
      await f.token.getVotes(f.outsider.address)
    ).to.equal(0n);

    await expect(
      f.token.connect(f.outsider).delegate(f.outsider.address)
    )
      .to.emit(f.token, "DelegateChanged")
      .withArgs(
        f.outsider.address,
        ethers.ZeroAddress,
        f.outsider.address
      );

    expect(
      await f.token.getVotes(f.outsider.address)
    ).to.equal(eth("100"));
  });

  it("updates delegated voting power when tokens move", async function () {
    const f = await loadFixture(deployDAOFixture);

    await expect(
      f.token.connect(f.alice).transfer(f.bob.address, eth("100"))
    )
      .to.emit(f.token, "Transfer")
      .withArgs(f.alice.address, f.bob.address, eth("100"));

    expect(
      await f.token.getVotes(f.alice.address)
    ).to.equal(eth("500"));

    expect(
      await f.token.getVotes(f.bob.address)
    ).to.equal(eth("500"));
  });
});

describe("DAOGovernor", function () {
  it("assigns three administrative roles", async function () {
    const f = await loadFixture(deployDAOFixture);

    expect(
      await f.governor.hasRole(
        ethers.ZeroHash,
        f.admin.address
      )
    ).to.equal(true);

    expect(
      await f.governor.hasRole(
        await f.governor.PROPOSER_ROLE(),
        f.admin.address
      )
    ).to.equal(true);

    expect(
      await f.governor.hasRole(
        await f.governor.GUARDIAN_ROLE(),
        f.guardian.address
      )
    ).to.equal(true);
  });

  it("creates a proposal and emits its complete data", async function () {
    const f = await loadFixture(deployDAOFixture);

    const tx = await f.governor.createProposal(
      f.bob.address,
      eth("0.1"),
      TEXT
    );

    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(
      receipt.blockNumber
    );

    await expect(tx)
      .to.emit(f.governor, "ProposalCreated")
      .withArgs(
        1n,
        f.admin.address,
        f.bob.address,
        eth("0.1"),
        BigInt(receipt.blockNumber),
        BigInt(block.timestamp + PERIOD),
        TEXT
      );

    const proposal = await f.governor.getProposal(1);

    expect(proposal.description).to.equal(TEXT);
    expect(proposal.executed).to.equal(false);
    expect(await f.governor.proposalCount()).to.equal(1n);
  });

  it("rejects proposal creation without the proposer role", async function () {
    const f = await loadFixture(deployDAOFixture);

    await expectDenied(
      f.governor
        .connect(f.outsider)
        .createProposal(f.bob.address, 1n, TEXT),
      f.governor,
      f.outsider,
      await f.governor.PROPOSER_ROLE()
    );
  });

  const invalidProposals = [
    [
      "zero recipient",
      ethers.ZeroAddress,
      1n,
      TEXT,
      "InvalidAddress",
      null,
    ],
    [
      "zero amount",
      null,
      0n,
      TEXT,
      "InvalidAmount",
      null,
    ],
    [
      "empty description",
      null,
      1n,
      "",
      "InvalidDescriptionLength",
      0n,
    ],
    [
      "oversized description",
      null,
      1n,
      "x".repeat(513),
      "InvalidDescriptionLength",
      513n,
    ],
  ];

  for (const [
    label,
    recipient,
    amount,
    text,
    error,
    argument,
  ] of invalidProposals) {
    it(`rejects a proposal with ${label}`, async function () {
      const f = await loadFixture(deployDAOFixture);

      const assertion = expect(
        f.governor.createProposal(
          recipient ?? f.bob.address,
          amount,
          text
        )
      ).to.be.revertedWithCustomError(f.governor, error);

      if (argument === null) {
        await assertion;
      } else {
        await assertion.withArgs(argument);
      }
    });
  }

  it("accepts a description of exactly 512 bytes", async function () {
    const f = await loadFixture(deployDAOFixture);
    const description = "x".repeat(512);

    await f.governor.createProposal(
      f.bob.address,
      1n,
      description
    );

    expect(
      (await f.governor.getProposal(1)).description
    ).to.equal(description);
  });

  it("keeps a proposal pending in its snapshot block", async function () {
    const f = await loadFixture(proposalFixture);

    expect(await f.governor.state(f.id)).to.equal(0n);

    await expect(
      f.governor.castVote.staticCall(f.id, 1)
    )
      .to.be.revertedWithCustomError(
        f.governor,
        "UnexpectedProposalState"
      )
      .withArgs(f.id, 0n, 1n);
  });

  it("rejects a quorum query before the snapshot is historical", async function () {
    const f = await loadFixture(proposalFixture);
    const proposal = await f.governor.getProposal(f.id);

    await expect(f.governor.quorum(f.id))
      .to.be.revertedWithCustomError(
        f.governor,
        "SnapshotNotReady"
      )
      .withArgs(proposal.snapshotBlock);
  });

  it("activates voting and requires a quorum of 200 DVT", async function () {
    const f = await loadFixture(activeFixture);

    expect(await f.governor.state(f.id)).to.equal(1n);
    expect(await f.governor.quorum(f.id)).to.equal(eth("200"));
  });

  for (const [support, field] of [
    [0, "againstVotes"],
    [1, "forVotes"],
    [2, "abstainVotes"],
  ]) {
    it(`records vote type ${support} with historical weight`, async function () {
      const f = await loadFixture(activeFixture);

      await expect(
        f.governor.connect(f.alice).castVote(f.id, support)
      )
        .to.emit(f.governor, "VoteCast")
        .withArgs(
          f.id,
          f.alice.address,
          support,
          eth("600")
        );

      expect(
        (await f.governor.getProposal(f.id))[field]
      ).to.equal(eth("600"));

      expect(
        await f.governor.hasVoted(f.id, f.alice.address)
      ).to.equal(true);
    });
  }

  it("rejects voting twice", async function () {
    const f = await loadFixture(activeFixture);

    await f.governor.connect(f.alice).castVote(f.id, 1);

    await expect(
      f.governor.connect(f.alice).castVote(f.id, 0)
    )
      .to.be.revertedWithCustomError(
        f.governor,
        "AlreadyVoted"
      )
      .withArgs(f.id, f.alice.address);
  });

  it("rejects voters without historical voting power", async function () {
    const f = await loadFixture(activeFixture);

    await expect(
      f.governor.connect(f.outsider).castVote(f.id, 1)
    )
      .to.be.revertedWithCustomError(
        f.governor,
        "NoVotingPower"
      )
      .withArgs(f.outsider.address);
  });

  it("rejects an invalid vote type", async function () {
    const f = await loadFixture(activeFixture);

    await expect(f.governor.castVote(f.id, 3))
      .to.be.revertedWithCustomError(
        f.governor,
        "InvalidVoteType"
      )
      .withArgs(3);
  });

  it("prevents reusing votes by transferring tokens after the snapshot", async function () {
    const f = await loadFixture(activeFixture);

    await f.token
      .connect(f.alice)
      .transfer(f.outsider.address, eth("600"));

    await f.token
      .connect(f.outsider)
      .delegate(f.outsider.address);

    expect(
      await f.token.getVotes(f.alice.address)
    ).to.equal(0n);

    expect(
      await f.token.getVotes(f.outsider.address)
    ).to.equal(eth("600"));

    await f.governor.connect(f.alice).castVote(f.id, 1);

    expect(
      (await f.governor.getProposal(f.id)).forVotes
    ).to.equal(eth("600"));

    await expect(
      f.governor.connect(f.outsider).castVote(f.id, 1)
    ).to.be.revertedWithCustomError(
      f.governor,
      "NoVotingPower"
    );
  });

  it("accepts a vote one second before the deadline", async function () {
    const f = await loadFixture(activeFixture);
    const proposal = await f.governor.getProposal(f.id);

    await time.setNextBlockTimestamp(
      proposal.deadline - 1n
    );

    await expect(
      f.governor.connect(f.alice).castVote(f.id, 1)
    ).to.emit(f.governor, "VoteCast");
  });

  for (const secondsAfter of [0n, 1n]) {
    it(`rejects voting at deadline + ${secondsAfter} seconds`, async function () {
      const f = await loadFixture(activeFixture);
      const proposal = await f.governor.getProposal(f.id);

      await time.setNextBlockTimestamp(
        proposal.deadline + secondsAfter
      );

      await expect(
        f.governor.connect(f.alice).castVote(f.id, 1)
      )
        .to.be.revertedWithCustomError(
          f.governor,
          "UnexpectedProposalState"
        )
        .withArgs(f.id, 2n, 1n);
    });
  }

  const votingResults = [
    ["insufficient quorum", "150", 1, null, 2n],
    ["exact quorum", "200", 1, null, 3n],
    ["abstentions contributing to quorum", "100", 1, 2, 3n],
    ["a tie", "500", 1, 0, 2n],
    ["more votes against", "600", 0, 1, 2n],
  ];

  for (const [
    label,
    aliceBalance,
    aliceSupport,
    bobSupport,
    expected,
  ] of votingResults) {
    it(`handles ${label}`, async function () {
      const f = await loadFixture(deployDAOFixture);

      const transfer = eth("600") - eth(aliceBalance);

      if (transfer > 0n) {
        await f.token
          .connect(f.alice)
          .transfer(f.bob.address, transfer);
      }

      await f.governor.createProposal(
        f.bob.address,
        eth("0.1"),
        TEXT
      );

      await f.governor
        .connect(f.alice)
        .castVote(1, aliceSupport);

      if (bobSupport !== null) {
        await f.governor
          .connect(f.bob)
          .castVote(1, bobSupport);
      }

      const proposal = await f.governor.getProposal(1);
      await time.increaseTo(proposal.deadline);

      expect(await f.governor.state(1)).to.equal(expected);
    });
  }

  it("executes an approved proposal through the treasury", async function () {
    const f = await loadFixture(approvedFixture);

    await expect(
      f.governor.connect(f.outsider).execute(f.id)
    )
      .to.emit(f.governor, "ProposalExecuted")
      .withArgs(
        f.id,
        f.outsider.address,
        f.bob.address,
        eth("0.1")
      )
      .and.to.emit(f.treasury, "PayoutReserved")
      .withArgs(f.id, f.bob.address, eth("0.1"));

    expect(await f.governor.state(f.id)).to.equal(4n);

    expect(
      await f.treasury.claimable(f.bob.address)
    ).to.equal(eth("0.1"));

    expect(
      await f.treasury.totalReserved()
    ).to.equal(eth("0.1"));

    expect(
      await f.treasury.availableBalance()
    ).to.equal(eth("0.9"));

    expect(
      await ethers.provider.getBalance(f.treasury.target)
    ).to.equal(eth("1"));
  });

  it("rejects execution before the voting deadline", async function () {
    const f = await loadFixture(activeFixture);

    await expect(f.governor.execute(f.id))
      .to.be.revertedWithCustomError(
        f.governor,
        "UnexpectedProposalState"
      )
      .withArgs(f.id, 1n, 3n);
  });

  it("rejects execution of a defeated proposal", async function () {
    const f = await loadFixture(activeFixture);

    await time.increaseTo(
      (await f.governor.getProposal(f.id)).deadline
    );

    await expect(f.governor.execute(f.id))
      .to.be.revertedWithCustomError(
        f.governor,
        "UnexpectedProposalState"
      )
      .withArgs(f.id, 2n, 3n);
  });

  it("rejects repeated execution", async function () {
    const f = await loadFixture(approvedFixture);

    await f.governor.execute(f.id);

    await expect(f.governor.execute(f.id))
      .to.be.revertedWithCustomError(
        f.governor,
        "UnexpectedProposalState"
      )
      .withArgs(f.id, 4n, 3n);
  });

  it("rolls back execution if funds are insufficient and allows a retry", async function () {
    const f = await loadFixture(deployDAOFixture);

    await f.governor.createProposal(
      f.bob.address,
      eth("2"),
      TEXT
    );

    await f.governor.connect(f.alice).castVote(1, 1);

    await time.increaseTo(
      (await f.governor.getProposal(1)).deadline
    );

    await expect(f.governor.execute(1))
      .to.be.revertedWithCustomError(
        f.treasury,
        "InsufficientAvailableFunds"
      )
      .withArgs(eth("1"), eth("2"));

    expect(
      (await f.governor.getProposal(1)).executed
    ).to.equal(false);

    expect(await f.treasury.totalReserved()).to.equal(0n);

    await f.treasury.deposit({ value: eth("1") });
    await f.governor.execute(1);

    expect(
      await f.treasury.claimable(f.bob.address)
    ).to.equal(eth("2"));
  });

  for (const id of [0n, 99n]) {
    it(`rejects unknown proposal ${id}`, async function () {
      const f = await loadFixture(deployDAOFixture);

      await expect(f.governor.getProposal(id))
        .to.be.revertedWithCustomError(
          f.governor,
          "UnknownProposal"
        )
        .withArgs(id);
    });
  }

  it("returns bounded pages including a partial final page", async function () {
    const f = await loadFixture(deployDAOFixture);

    for (let i = 1; i <= 3; i++) {
      await f.governor.createProposal(
        f.bob.address,
        BigInt(i),
        `Proposal ${i}`
      );
    }

    const first = await f.governor.getProposals(0, 2);
    const last = await f.governor.getProposals(2, 50);

    expect(first.length).to.equal(2);
    expect(first[0].description).to.equal("Proposal 1");
    expect(first[1].description).to.equal("Proposal 2");

    expect(last.length).to.equal(1);
    expect(last[0].description).to.equal("Proposal 3");

    expect(
      (await f.governor.getProposals(3, 10)).length
    ).to.equal(0);
  });

  for (const limit of [0, 51]) {
    it(`rejects page size ${limit}`, async function () {
      const f = await loadFixture(deployDAOFixture);

      await expect(f.governor.getProposals(0, limit))
        .to.be.revertedWithCustomError(
          f.governor,
          "InvalidPageSize"
        )
        .withArgs(limit);
    });
  }

  it("pauses critical operations and resumes them through the admin", async function () {
    const f = await loadFixture(approvedFixture);

    await expect(f.governor.connect(f.guardian).pause())
      .to.emit(f.governor, "Paused")
      .withArgs(f.guardian.address);

    const actions = [
      () => f.governor.createProposal(f.bob.address, 1n, TEXT),
      () => f.governor.connect(f.alice).castVote(f.id, 1),
      () => f.governor.execute(f.id),
    ];

    for (const action of actions) {
      await expect(action())
        .to.be.revertedWithCustomError(
          f.governor,
          "EnforcedPause"
        );
    }

    await expect(f.governor.unpause())
      .to.emit(f.governor, "Unpaused")
      .withArgs(f.admin.address);

    await f.governor.execute(f.id);
  });

  it("rejects unauthorized pause and unpause", async function () {
    const f = await loadFixture(deployDAOFixture);

    await expectDenied(
      f.governor.connect(f.outsider).pause(),
      f.governor,
      f.outsider,
      await f.governor.GUARDIAN_ROLE()
    );

    await expectDenied(
      f.governor.connect(f.outsider).unpause(),
      f.governor,
      f.outsider,
      ethers.ZeroHash
    );
  });
});

describe("DAOTreasury", function () {
  it("accepts direct ETH transfers and emits an event", async function () {
    const f = await loadFixture(deployDAOFixture);

    await expect(
      f.outsider.sendTransaction({
        to: f.treasury.target,
        value: eth("0.2"),
      })
    )
      .to.emit(f.treasury, "Deposited")
      .withArgs(f.outsider.address, eth("0.2"));

    expect(
      await f.treasury.availableBalance()
    ).to.equal(eth("1.2"));
  });

  it("accepts explicit deposits and emits an event", async function () {
    const f = await loadFixture(deployDAOFixture);

    await expect(
      f.treasury.connect(f.outsider).deposit({ value: 1n })
    )
      .to.emit(f.treasury, "Deposited")
      .withArgs(f.outsider.address, 1n);
  });

  it("rejects zero deposits through both entry points", async function () {
    const f = await loadFixture(deployDAOFixture);

    await expect(f.treasury.deposit())
      .to.be.revertedWithCustomError(
        f.treasury,
        "ZeroAmount"
      );

    await expect(
      f.admin.sendTransaction({
        to: f.treasury.target,
        value: 0n,
      })
    ).to.be.revertedWithCustomError(
      f.treasury,
      "ZeroAmount"
    );
  });

  it("only permits the voting contract to reserve payouts", async function () {
    const f = await loadFixture(deployDAOFixture);

    await expect(
      f.treasury.reservePayout(1, f.bob.address, 1n)
    )
      .to.be.revertedWithCustomError(
        f.treasury,
        "UnauthorizedGovernor"
      )
      .withArgs(f.admin.address);
  });

  it("does not allow replacing the bound governor", async function () {
    const f = await loadFixture(deployDAOFixture);

    await expect(f.treasury.setGovernor(f.token.target))
      .to.be.revertedWithCustomError(
        f.treasury,
        "GovernorAlreadySet"
      );
  });

  it("pays the recipient only when the recipient withdraws", async function () {
    const f = await loadFixture(approvedFixture);

    await f.governor.execute(f.id);

    await expect(f.treasury.connect(f.bob).withdraw())
      .to.changeEtherBalances(
        [f.treasury, f.bob],
        [-eth("0.1"), eth("0.1")]
      );

    expect(
      await f.treasury.claimable(f.bob.address)
    ).to.equal(0n);

    expect(await f.treasury.totalReserved()).to.equal(0n);

    expect(
      await f.treasury.availableBalance()
    ).to.equal(eth("0.9"));

    await expect(f.treasury.connect(f.bob).withdraw())
      .to.be.revertedWithCustomError(
        f.treasury,
        "NothingToWithdraw"
      );
  });

  it("emits the withdrawal event", async function () {
    const f = await loadFixture(approvedFixture);

    await f.governor.execute(f.id);

    await expect(f.treasury.connect(f.bob).withdraw())
      .to.emit(f.treasury, "Withdrawn")
      .withArgs(f.bob.address, eth("0.1"));
  });

  it("does not let another account claim the recipient's funds", async function () {
    const f = await loadFixture(approvedFixture);

    await f.governor.execute(f.id);

    await expect(f.treasury.connect(f.outsider).withdraw())
      .to.be.revertedWithCustomError(
        f.treasury,
        "NothingToWithdraw"
      );

    expect(
      await f.treasury.claimable(f.bob.address)
    ).to.equal(eth("0.1"));
  });

  it("pauses deposits, reservations and withdrawals", async function () {
    const f = await loadFixture(approvedFixture);

    await expect(f.treasury.connect(f.guardian).pause())
      .to.emit(f.treasury, "Paused")
      .withArgs(f.guardian.address);

    await expect(f.treasury.deposit({ value: 1n }))
      .to.be.revertedWithCustomError(
        f.treasury,
        "EnforcedPause"
      );

    await expect(
      f.admin.sendTransaction({
        to: f.treasury.target,
        value: 1n,
      })
    ).to.be.revertedWithCustomError(
      f.treasury,
      "EnforcedPause"
    );

    await expect(f.treasury.connect(f.bob).withdraw())
      .to.be.revertedWithCustomError(
        f.treasury,
        "EnforcedPause"
      );

    await expect(f.governor.execute(f.id))
      .to.be.revertedWithCustomError(
        f.treasury,
        "EnforcedPause"
      );

    expect(
      (await f.governor.getProposal(f.id)).executed
    ).to.equal(false);

    await expect(f.treasury.unpause())
      .to.emit(f.treasury, "Unpaused")
      .withArgs(f.admin.address);

    await f.governor.execute(f.id);
  });

  it("restricts treasury administrative operations", async function () {
    const f = await loadFixture(deployDAOFixture);

    await expectDenied(
      f.treasury.connect(f.outsider).pause(),
      f.treasury,
      f.outsider,
      await f.treasury.GUARDIAN_ROLE()
    );

    await expectDenied(
      f.treasury.connect(f.outsider).unpause(),
      f.treasury,
      f.outsider,
      ethers.ZeroHash
    );

    await expectDenied(
      f.treasury.connect(f.outsider).setGovernor(f.token.target),
      f.treasury,
      f.outsider,
      ethers.ZeroHash
    );
  });
});