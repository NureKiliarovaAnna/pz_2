// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title DAO treasury interface
/// @notice Defines treasury operations used by the voting contract.
interface IDAOTreasury {
    /// @notice Reserves funds for an approved proposal.
    /// @param proposalId Identifier of the approved proposal.
    /// @param recipient Address entitled to withdraw the funds.
    /// @param amount Amount of ETH in wei.
    function reservePayout(
        uint256 proposalId,
        address recipient,
        uint256 amount
    ) external;

    /// @notice Returns the ETH balance available for new payouts.
    /// @return Amount of unreserved ETH in wei.
    function availableBalance() external view returns (uint256);
}