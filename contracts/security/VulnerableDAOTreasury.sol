// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IDAOTreasury} from "../interfaces/IDAOTreasury.sol";

/// @title Vulnerable DAO treasury (educational copy)
/// @notice Навмисно вразливий навчальний контракт для локальних тестів.
/// У reservePayout пропущено перевірку повноважень.
/// @dev Exact copy of DAOTreasury except for the missing onlyGovernor
/// modifier on reservePayout. Never deploy outside local tests.
contract VulnerableDAOTreasury is
    IDAOTreasury,
    AccessControl,
    Pausable,
    ReentrancyGuard
{
    /// @notice Role permitted to activate the emergency pause.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @notice Voting contract permitted to reserve payouts.
    address public governor;

    /// @notice Total ETH reserved for recipients, in wei.
    uint256 public totalReserved;

    /// @notice Amount each recipient may withdraw, in wei.
    mapping(address => uint256) public claimable;

    /// @notice Indicates whether a proposal already reserved a payout.
    mapping(uint256 => bool) public payoutReserved;

    error InvalidAddress();
    error InvalidGovernor();
    error GovernorAlreadySet();
    error UnauthorizedGovernor(address caller);
    error ZeroAmount();
    error PayoutAlreadyReserved(uint256 proposalId);
    error InsufficientAvailableFunds(uint256 available, uint256 requested);
    error NothingToWithdraw();
    error TransferFailed();

    event GovernorSet(address indexed governor);

    event Deposited(
        address indexed sender,
        uint256 amount
    );

    event PayoutReserved(
        uint256 indexed proposalId,
        address indexed recipient,
        uint256 amount
    );

    event Withdrawn(
        address indexed recipient,
        uint256 amount
    );

    /// @notice Restricts payout reservations to the voting contract.
    modifier onlyGovernor() {
        if (msg.sender != governor) {
            revert UnauthorizedGovernor(msg.sender);
        }

        _;
    }

    /// @notice Creates the treasury and assigns administrative roles.
    /// @param admin Address managing roles and resuming operations.
    /// @param guardian Address permitted to pause operations.
    constructor(address admin, address guardian) {
        if (admin == address(0) || guardian == address(0)) {
            revert InvalidAddress();
        }

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    /// @notice Accepts ETH sent directly to the treasury.
    receive() external payable whenNotPaused {
        _recordDeposit();
    }

    /// @notice Accepts an explicit ETH deposit.
    function deposit() external payable whenNotPaused {
        _recordDeposit();
    }

    /// @notice Permanently binds the treasury to its voting contract.
    /// @param governorAddress Address of the deployed voting contract.
    function setGovernor(
        address governorAddress
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (governor != address(0)) {
            revert GovernorAlreadySet();
        }

        if (governorAddress == address(0)) {
            revert InvalidAddress();
        }

        if (governorAddress.code.length == 0) {
            revert InvalidGovernor();
        }

        governor = governorAddress;

        emit GovernorSet(governorAddress);
    }

    /// @notice Returns funds not already reserved for recipients.
    /// @return Amount of available ETH in wei.
    function availableBalance()
        public
        view
        override
        returns (uint256)
    {
        return address(this).balance - totalReserved;
    }

    /// @notice Reserves a payout after the voting contract approves it.
    /// @dev VULNERABILITY: the onlyGovernor modifier is intentionally
    /// missing, so any account can reserve any available funds.
    /// @param proposalId Identifier of the approved proposal.
    /// @param recipient Address entitled to withdraw the funds.
    /// @param amount Amount of ETH in wei.
    function reservePayout(
        uint256 proposalId,
        address recipient,
        uint256 amount
    ) external override whenNotPaused {
        if (recipient == address(0)) {
            revert InvalidAddress();
        }

        if (amount == 0) {
            revert ZeroAmount();
        }

        if (payoutReserved[proposalId]) {
            revert PayoutAlreadyReserved(proposalId);
        }

        uint256 available = availableBalance();

        if (amount > available) {
            revert InsufficientAvailableFunds(available, amount);
        }

        payoutReserved[proposalId] = true;

        claimable[recipient] += amount;
        totalReserved += amount;

        emit PayoutReserved(proposalId, recipient, amount);
    }

    /// @notice Withdraws all approved funds belonging to the caller.
    /// @dev Updates accounting before making the external ETH transfer.
    function withdraw() external nonReentrant whenNotPaused {
        uint256 amount = claimable[msg.sender];

        if (amount == 0) {
            revert NothingToWithdraw();
        }

        claimable[msg.sender] = 0;
        totalReserved -= amount;

        (bool success, ) = payable(msg.sender).call{value: amount}("");

        if (!success) {
            revert TransferFailed();
        }

        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Pauses deposits, payout reservations and withdrawals.
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    /// @notice Resumes operations after an emergency pause.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @dev Validates the deposit and records it in the event log.
    function _recordDeposit() private {
        if (msg.value == 0) {
            revert ZeroAmount();
        }

        emit Deposited(msg.sender, msg.value);
    }
}