// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IWithdrawable {
    function withdraw() external;
}

/// @title Test-only recipient that can refuse ETH
/// @notice Simulates a payout recipient whose receive() reverts.
/// @dev Used only in test configurations, never in deployment scripts.
contract RejectingRecipient {
    /// @notice When false, every incoming ETH transfer is rejected.
    bool public acceptPayments;

    error PaymentRejected();

    /// @notice Switches between rejecting and accepting ETH.
    function setAcceptPayments(bool accept) external {
        acceptPayments = accept;
    }

    /// @notice Calls withdraw() on the treasury as the recipient.
    function withdrawFrom(address treasury) external {
        IWithdrawable(treasury).withdraw();
    }

    receive() external payable {
        if (!acceptPayments) {
            revert PaymentRejected();
        }
    }
}
