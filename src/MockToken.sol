// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @title MockToken
/// @notice ERC20 test asset with an open faucet, used for SafeLend's markets.
/// @dev    Testnet/demo only — a real asset would never expose an unbounded mint.
contract MockToken is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 100 ether;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
