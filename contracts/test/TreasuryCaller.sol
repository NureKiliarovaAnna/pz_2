// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDAOTreasury} from "../interfaces/IDAOTreasury.sol";

/// @title Test-only governor stand-in
/// @notice Lets tests call reservePayout directly with arbitrary arguments,
/// reaching treasury checks that DAOGovernor already filters out.
/// @dev Used only in test configurations, never in deployment scripts.
contract TreasuryCaller {
    /// @notice Forwards a payout reservation to the treasury.
    function reserve(
        address treasury,
        uint256 proposalId,
        address recipient,
        uint256 amount
    ) external {
        IDAOTreasury(treasury).reservePayout(proposalId, recipient, amount);
    }
}
