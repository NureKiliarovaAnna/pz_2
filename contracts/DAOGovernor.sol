// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

import {IDAOTreasury} from "./interfaces/IDAOTreasury.sol";

/// @title DAO proposal and voting system
/// @notice Uses historical voting power to approve treasury payouts.
contract DAOGovernor is AccessControl, Pausable, ReentrancyGuard {
    /// @notice Role permitted to create proposals.
    bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");

    /// @notice Role permitted to activate the emergency pause.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @notice Quorum: 2000 basis points equals 20 percent.
    uint256 public constant QUORUM_BPS = 2000;

    /// @notice Denominator used for basis-point calculations.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Maximum number of proposals returned per page.
    uint256 public constant MAX_PAGE_SIZE = 50;

    /// @notice Maximum proposal description length in UTF-8 bytes.
    uint256 public constant MAX_DESCRIPTION_LENGTH = 512;

    /// @notice Minimum voting period in seconds.
    uint256 public constant MIN_VOTING_PERIOD = 60;

    /// @notice Maximum voting period in seconds.
    uint256 public constant MAX_VOTING_PERIOD = 30 days;

    /// @notice Voting token accessed through the OpenZeppelin interface.
    IVotes public immutable token;

    /// @notice Treasury accessed through its interface.
    IDAOTreasury public immutable treasury;

    /// @notice Voting period in seconds.
    uint256 public immutable votingPeriod;

    /// @notice Number of created proposals.
    uint256 public proposalCount;

    enum ProposalState {
        Pending,
        Active,
        Defeated,
        Succeeded,
        Executed
    }

    /// @dev Field order is chosen for storage packing:
    /// slot 0 = proposer (20 bytes) + executed (1 byte);
    /// slot 1 = recipient (20) + snapshotBlock (6) + deadline (6).
    /// uint48 is the OpenZeppelin standard width for timepoints (ERC-6372).
    struct Proposal {
        address proposer;
        bool executed;
        address recipient;
        uint48 snapshotBlock;
        uint48 deadline;
        uint256 amount;
        uint256 againstVotes;
        uint256 forVotes;
        uint256 abstainVotes;
        string description;
    }

    mapping(uint256 => Proposal) private _proposals;

    /// @notice Records whether an address voted on a proposal.
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    error InvalidAddress();
    error InvalidContractAddress(address account);
    error InvalidVotingPeriod(uint256 period);
    error InvalidAmount();
    error InvalidDescriptionLength(uint256 length);
    error UnknownProposal(uint256 proposalId);
    error InvalidVoteType(uint8 support);
    error AlreadyVoted(uint256 proposalId, address voter);
    error NoVotingPower(address voter);
    error InvalidPageSize(uint256 limit);
    error SnapshotNotReady(uint256 snapshotBlock);

    error UnexpectedProposalState(
        uint256 proposalId,
        ProposalState currentState,
        ProposalState requiredState
    );

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        address indexed recipient,
        uint256 amount,
        uint256 snapshotBlock,
        uint256 deadline,
        string description
    );

    event VoteCast(
        uint256 indexed proposalId,
        address indexed voter,
        uint8 support,
        uint256 weight
    );

    event ProposalExecuted(
        uint256 indexed proposalId,
        address indexed executor,
        address indexed recipient,
        uint256 amount
    );

    /// @notice Creates the voting system and assigns roles.
    /// @param tokenAddress Address of the DAO voting token.
    /// @param treasuryAddress Address of the DAO treasury.
    /// @param admin Address managing roles and resuming operations.
    /// @param proposer Address initially permitted to create proposals.
    /// @param guardian Address permitted to pause operations.
    /// @param votingPeriodSeconds Voting duration in seconds.
    constructor(
        address tokenAddress,
        address treasuryAddress,
        address admin,
        address proposer,
        address guardian,
        uint256 votingPeriodSeconds
    ) {
        if (
            admin == address(0) ||
            proposer == address(0) ||
            guardian == address(0)
        ) {
            revert InvalidAddress();
        }

        if (tokenAddress.code.length == 0) {
            revert InvalidContractAddress(tokenAddress);
        }

        if (treasuryAddress.code.length == 0) {
            revert InvalidContractAddress(treasuryAddress);
        }

        if (
            votingPeriodSeconds < MIN_VOTING_PERIOD ||
            votingPeriodSeconds > MAX_VOTING_PERIOD
        ) {
            revert InvalidVotingPeriod(votingPeriodSeconds);
        }

        token = IVotes(tokenAddress);
        treasury = IDAOTreasury(treasuryAddress);
        votingPeriod = votingPeriodSeconds;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PROPOSER_ROLE, proposer);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    /// @notice Creates a proposal to fund a recipient.
    /// @param recipient Address entitled to the approved payout.
    /// @param amount Requested ETH amount in wei.
    /// @param description Text explaining the proposal.
    /// @return proposalId Identifier of the created proposal.
    function createProposal(
        address recipient,
        uint256 amount,
        string calldata description
    )
        external
        onlyRole(PROPOSER_ROLE)
        whenNotPaused
        returns (uint256 proposalId)
    {
        if (recipient == address(0)) {
            revert InvalidAddress();
        }

        if (amount == 0) {
            revert InvalidAmount();
        }

        uint256 descriptionLength = bytes(description).length;

        if (
            descriptionLength == 0 ||
            descriptionLength > MAX_DESCRIPTION_LENGTH
        ) {
            revert InvalidDescriptionLength(descriptionLength);
        }

        proposalId = ++proposalCount;

        Proposal storage proposal = _proposals[proposalId];

        uint48 snapshotBlock = SafeCast.toUint48(block.number);
        uint48 deadline = SafeCast.toUint48(block.timestamp + votingPeriod);

        proposal.proposer = msg.sender;
        proposal.recipient = recipient;
        proposal.snapshotBlock = snapshotBlock;
        proposal.deadline = deadline;
        proposal.amount = amount;
        proposal.description = description;

        emit ProposalCreated(
            proposalId,
            msg.sender,
            recipient,
            amount,
            snapshotBlock,
            deadline,
            description
        );
    }

    /// @notice Casts a vote using voting power at the proposal snapshot.
    /// @param proposalId Identifier of the proposal.
    /// @param support Vote type: 0 against, 1 for, 2 abstain.
    function castVote(
        uint256 proposalId,
        uint8 support
    ) external whenNotPaused {
        if (support > 2) {
            revert InvalidVoteType(support);
        }

        Proposal storage proposal = _getProposal(proposalId);

        ProposalState currentState = state(proposalId);

        if (currentState != ProposalState.Active) {
            revert UnexpectedProposalState(
                proposalId,
                currentState,
                ProposalState.Active
            );
        }

        if (hasVoted[proposalId][msg.sender]) {
            revert AlreadyVoted(proposalId, msg.sender);
        }

        uint256 weight = token.getPastVotes(
            msg.sender,
            proposal.snapshotBlock
        );

        if (weight == 0) {
            revert NoVotingPower(msg.sender);
        }

        hasVoted[proposalId][msg.sender] = true;

        if (support == 0) {
            proposal.againstVotes += weight;
        } else if (support == 1) {
            proposal.forVotes += weight;
        } else {
            proposal.abstainVotes += weight;
        }

        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    /// @notice Executes an approved proposal by reserving its payout.
    /// @param proposalId Identifier of the proposal.
    function execute(
        uint256 proposalId
    ) external nonReentrant whenNotPaused {
        Proposal storage proposal = _getProposal(proposalId);

        ProposalState currentState = state(proposalId);

        if (currentState != ProposalState.Succeeded) {
            revert UnexpectedProposalState(
                proposalId,
                currentState,
                ProposalState.Succeeded
            );
        }

        proposal.executed = true;

        treasury.reservePayout(
            proposalId,
            proposal.recipient,
            proposal.amount
        );

        emit ProposalExecuted(
            proposalId,
            msg.sender,
            proposal.recipient,
            proposal.amount
        );
    }

    /// @notice Returns the current proposal state.
    /// @param proposalId Identifier of the proposal.
    /// @return Current state derived from votes, time and execution.
    function state(
        uint256 proposalId
    ) public view returns (ProposalState) {
        Proposal storage proposal = _getProposal(proposalId);

        if (proposal.executed) {
            return ProposalState.Executed;
        }

        if (block.number <= proposal.snapshotBlock) {
            return ProposalState.Pending;
        }

        if (block.timestamp < proposal.deadline) {
            return ProposalState.Active;
        }

        uint256 participation =
            proposal.againstVotes +
            proposal.forVotes +
            proposal.abstainVotes;

        if (
            participation >= _quorum(proposal.snapshotBlock) &&
            proposal.forVotes > proposal.againstVotes
        ) {
            return ProposalState.Succeeded;
        }

        return ProposalState.Defeated;
    }

    /// @notice Returns the quorum for a proposal's historical supply.
    /// @param proposalId Identifier of the proposal.
    /// @return Required voting weight in token base units.
    function quorum(
        uint256 proposalId
    ) external view returns (uint256) {
        Proposal storage proposal = _getProposal(proposalId);

        if (block.number <= proposal.snapshotBlock) {
            revert SnapshotNotReady(proposal.snapshotBlock);
        }

        return _quorum(proposal.snapshotBlock);
    }

    /// @notice Returns a single proposal.
    /// @param proposalId Identifier of the proposal.
    /// @return Proposal data including vote totals.
    function getProposal(
        uint256 proposalId
    ) external view returns (Proposal memory) {
        return _getProposal(proposalId);
    }

    /// @notice Returns a bounded page of proposal records.
    /// @param offset Number of records to skip, starting from zero.
    /// @param limit Maximum number of records to return, from 1 to 50.
    /// @return page Requested proposal records.
    function getProposals(
        uint256 offset,
        uint256 limit
    ) external view returns (Proposal[] memory page) {
        if (limit == 0 || limit > MAX_PAGE_SIZE) {
            revert InvalidPageSize(limit);
        }

        if (offset >= proposalCount) {
            return new Proposal[](0);
        }

        uint256 remaining = proposalCount - offset;
        uint256 size = remaining < limit ? remaining : limit;

        page = new Proposal[](size);

        for (uint256 i = 0; i < size; ++i) {
            page[i] = _proposals[offset + i + 1];
        }
    }

    /// @notice Pauses proposal creation, voting and execution.
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    /// @notice Resumes operations after an emergency pause.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @dev Retrieves an existing proposal from storage.
    function _getProposal(
        uint256 proposalId
    ) private view returns (Proposal storage proposal) {
        if (proposalId == 0 || proposalId > proposalCount) {
            revert UnknownProposal(proposalId);
        }

        return _proposals[proposalId];
    }

    /// @dev Calculates quorum using historical supply, rounding upward.
    function _quorum(
        uint256 snapshotBlock
    ) private view returns (uint256) {
        uint256 historicalSupply = token.getPastTotalSupply(
            snapshotBlock
        );

        return Math.mulDiv(
            historicalSupply,
            QUORUM_BPS,
            BPS_DENOMINATOR,
            Math.Rounding.Ceil
        );
    }
}