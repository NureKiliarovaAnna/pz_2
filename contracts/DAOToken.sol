// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title DAO voting token
/// @notice ERC-20 token with historical voting power checkpoints.
contract DAOToken is ERC20, ERC20Votes {
    /// @notice Fixed supply: 1000 tokens with 18 decimal places.
    uint256 public constant INITIAL_SUPPLY = 1_000 * 10 ** 18;

    /// @notice The initial token holder cannot be the zero address.
    error InvalidInitialHolder();

    /// @notice Creates the token and issues its entire supply.
    /// @param initialHolder Address receiving all initial tokens.
    constructor(address initialHolder)
        ERC20("DAO Vote", "DVT")
        EIP712("DAO Vote", "1")
    {
        if (initialHolder == address(0)) {
            revert InvalidInitialHolder();
        }

        _mint(initialHolder, INITIAL_SUPPLY);
    }

    /// @dev Updates token balances and voting power checkpoints.
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }
}