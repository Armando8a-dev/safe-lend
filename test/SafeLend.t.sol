// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SafeLend} from "../src/SafeLend.sol";
import {MockToken} from "../src/MockToken.sol";

contract SafeLendTest is Test {
    SafeLend lend;
    MockToken weth; // volatile collateral
    MockToken usdc; // stable, the borrowable asset

    address alice = makeAddr("alice");        // borrower
    address lp = makeAddr("lp");              // supplies USDC liquidity
    address liquidator = makeAddr("liquidator");

    uint256 constant WETH_PRICE = 2000 ether; // $2000, PRICE_SCALE = 1e18
    uint256 constant USDC_PRICE = 1 ether;    // $1
    uint256 constant WETH_CF = 7500;          // 75%
    uint256 constant USDC_CF = 9000;          // 90%

    function setUp() public {
        lend = new SafeLend();
        weth = new MockToken("Wrapped Ether", "WETH");
        usdc = new MockToken("USD Coin", "USDC");

        lend.listMarket(address(weth), WETH_CF, WETH_PRICE);
        lend.listMarket(address(usdc), USDC_CF, USDC_PRICE);

        // LP seeds USDC liquidity so it can be borrowed.
        usdc.mint(lp, 100_000 ether);
        vm.startPrank(lp);
        usdc.approve(address(lend), type(uint256).max);
        lend.deposit(address(usdc), 100_000 ether);
        vm.stopPrank();

        // Alice gets WETH collateral.
        weth.mint(alice, 10 ether);
        vm.prank(alice);
        weth.approve(address(lend), type(uint256).max);

        // Liquidator holds USDC to repay debt with.
        usdc.mint(liquidator, 100_000 ether);
        vm.prank(liquidator);
        usdc.approve(address(lend), type(uint256).max);
    }

    function _aliceDepositsAndBorrows(uint256 wethAmt, uint256 usdcAmt) internal {
        vm.startPrank(alice);
        lend.deposit(address(weth), wethAmt);
        lend.borrow(address(usdc), usdcAmt);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Borrow within / beyond collateral
    // ─────────────────────────────────────────────────────────────────────

    function test_Borrow_WithinLimit_Succeeds() public {
        // 1 WETH = $2000, borrow power = 2000 × 75% = $1500.
        _aliceDepositsAndBorrows(1 ether, 1000 ether); // borrow $1000 < $1500
        assertEq(usdc.balanceOf(alice), 1000 ether, "received borrowed USDC");
        // HF = 1500 / 1000 = 1.5 → 15000 BPS
        assertEq(lend.healthFactor(alice), 15_000);
    }

    function test_Borrow_BeyondCollateral_Reverts() public {
        vm.startPrank(alice);
        lend.deposit(address(weth), 1 ether); // $1500 borrow power
        vm.expectRevert("Borrow exceeds collateral");
        lend.borrow(address(usdc), 1600 ether); // > $1500
        vm.stopPrank();
    }

    function test_Withdraw_ThatBreaksHealth_Reverts() public {
        _aliceDepositsAndBorrows(1 ether, 1000 ether);
        // Withdrawing most of the collateral would leave debt uncovered.
        vm.prank(alice);
        vm.expectRevert("Withdrawal leaves position unhealthy");
        lend.withdraw(address(weth), 0.5 ether);
    }

    function test_Repay_ReducesDebtAndRestoresHealth() public {
        _aliceDepositsAndBorrows(1 ether, 1000 ether);
        vm.startPrank(alice);
        usdc.approve(address(lend), type(uint256).max);
        lend.repay(address(usdc), 1000 ether);
        vm.stopPrank();
        assertEq(lend.debtValue(alice), 0, "debt cleared");
        assertEq(lend.healthFactor(alice), type(uint256).max, "no debt means max health");
    }

    // ─────────────────────────────────────────────────────────────────────
    //  THE HEADLINE: a price drop makes a position liquidatable
    // ─────────────────────────────────────────────────────────────────────

    function test_PriceDrop_MakesPositionLiquidatable_AndLiquidationWorks() public {
        _aliceDepositsAndBorrows(1 ether, 1000 ether); // $1000 debt, $1500 power, HF 1.5
        assertFalse(lend.isLiquidatable(alice), "healthy before the drop");

        // WETH crashes from $2000 to $1200. Borrow power = 1200 × 75% = $900 < $1000 debt.
        lend.setPrice(address(weth), 1200 ether);
        assertTrue(lend.isLiquidatable(alice), "underwater after the drop");
        assertEq(lend.healthFactor(alice), 9000, "HF equals 9000 BPS");

        // Liquidator repays $500 of USDC debt, seizes WETH worth $500 × 1.05 = $525.
        uint256 seizeExpected = (525 ether * 1e18) / (1200 ether); // ≈ 0.4375 WETH
        uint256 liqWethBefore = weth.balanceOf(liquidator);

        vm.prank(liquidator);
        lend.liquidate(alice, address(usdc), 500 ether, address(weth));

        assertEq(weth.balanceOf(liquidator) - liqWethBefore, seizeExpected, "liquidator seized collateral + 5% bonus");
        assertEq(lend.borrows(alice, address(usdc)), 500 ether, "half the debt repaid");
        assertEq(lend.deposits(alice, address(weth)), 1 ether - seizeExpected, "collateral seized from borrower");
    }

    function test_Liquidate_HealthyPosition_Reverts() public {
        _aliceDepositsAndBorrows(1 ether, 500 ether); // very safe, HF = 3.0
        vm.prank(liquidator);
        vm.expectRevert("Borrower is healthy");
        lend.liquidate(alice, address(usdc), 100 ether, address(weth));
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Liquidity accounting
    // ─────────────────────────────────────────────────────────────────────

    function test_Borrow_BeyondAvailableLiquidity_Reverts() public {
        // A tiny pool: only 100 USDC of liquidity available beyond what's borrowed.
        SafeLend small = new SafeLend();
        small.listMarket(address(weth), WETH_CF, WETH_PRICE);
        small.listMarket(address(usdc), USDC_CF, USDC_PRICE);

        usdc.mint(lp, 100 ether);
        vm.startPrank(lp);
        usdc.approve(address(small), type(uint256).max);
        small.deposit(address(usdc), 100 ether);
        vm.stopPrank();

        weth.mint(alice, 1 ether);
        vm.startPrank(alice);
        weth.approve(address(small), type(uint256).max);
        small.deposit(address(weth), 1 ether); // $1500 power, plenty
        vm.expectRevert("Insufficient liquidity");
        small.borrow(address(usdc), 200 ether); // but only 100 in the pool
        vm.stopPrank();
    }
}
