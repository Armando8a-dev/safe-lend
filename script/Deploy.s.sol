// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SafeLend} from "../src/SafeLend.sol";
import {MockToken} from "../src/MockToken.sol";

/// @notice Deploys the SafeLend demo: WETH + USDC markets and a USDC liquidity
///         pool the deployer seeds so borrowing works out of the box.
/// @dev    WETH is the volatile collateral (price $2000, CF 75%); USDC is the
///         stable borrowable asset (price $1, CF 90%). To demo a liquidation,
///         the owner can later drop WETH's price with `setPrice`.
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();

        SafeLend lend = new SafeLend();
        MockToken weth = new MockToken("Wrapped Ether", "WETH");
        MockToken usdc = new MockToken("USD Coin", "USDC");

        lend.listMarket(address(weth), 7500, 2000 ether); // 75% CF, $2000
        lend.listMarket(address(usdc), 9000, 1 ether);    // 90% CF, $1

        // Seed the pool with USDC so users can borrow immediately.
        usdc.mint(msg.sender, 50_000 ether);
        usdc.approve(address(lend), 50_000 ether);
        lend.deposit(address(usdc), 50_000 ether);

        vm.stopBroadcast();

        console.log("SafeLend :", address(lend));
        console.log("WETH     :", address(weth));
        console.log("USDC     :", address(usdc));
        console.log("USDC liquidity seeded: 50,000");
    }
}
