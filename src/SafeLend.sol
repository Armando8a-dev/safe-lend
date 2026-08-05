// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

/// @title SafeLend
/// @notice An over-collateralized lending market: deposit assets as collateral,
///         borrow other assets against them, and get liquidated if your position
///         falls underwater. Values are priced through a per-market oracle so the
///         protocol works across assets of *different* prices — not just 1:1.
/// @dev    This is the deliberate fix for the block's design, which summed token
///         amounts directly with no oracle, silently assuming every asset was
///         worth the same (i.e. only correct for a basket of equal-priced
///         stablecoins). Here each market carries a `price`, so collateral and
///         debt are compared by *value*, and a price move can make a position
///         liquidatable — the mechanism that keeps a real lending pool solvent.
///
///         Simplifications kept explicit: prices are owner-set (a real deployment
///         would read Chainlink), and interest accrual is out of scope — this
///         models the collateral/health/liquidation core, not a full money market.
contract SafeLend is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant BASIS_POINTS = 10_000;
    uint256 public constant PRICE_SCALE = 1e18;    // price is USD × 1e18 per whole token
    uint256 public constant LIQUIDATION_BONUS = 500; // 5% collateral bonus to liquidators

    struct Market {
        bool listed;
        uint256 collateralFactor; // borrow power per unit of collateral value, in BPS (e.g. 7500 = 75%)
        uint256 price;            // USD price, scaled by PRICE_SCALE
        uint256 totalSupplied;    // total deposited into this market
        uint256 totalBorrowed;    // total borrowed from this market
    }

    address[] public marketList;
    mapping(address => Market) public markets;
    mapping(address => mapping(address => uint256)) public deposits; // user => token => amount
    mapping(address => mapping(address => uint256)) public borrows;  // user => token => amount

    event MarketListed(address indexed token, uint256 collateralFactor, uint256 price);
    event PriceUpdated(address indexed token, uint256 price);
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event Borrowed(address indexed user, address indexed token, uint256 amount);
    event Repaid(address indexed user, address indexed token, uint256 amount);
    event Liquidated(
        address indexed liquidator, address indexed borrower,
        address repayToken, uint256 repayAmount, address seizeToken, uint256 seizeAmount
    );

    constructor() Ownable(msg.sender) {}

    // ─────────────────────────────────────────────────────────────────────
    //  Owner: markets & the (mock) oracle
    // ─────────────────────────────────────────────────────────────────────

    function listMarket(address token, uint256 collateralFactor, uint256 price) external onlyOwner {
        require(token != address(0), "Invalid token");
        require(!markets[token].listed, "Already listed");
        require(collateralFactor <= BASIS_POINTS, "CF too high");
        require(price > 0, "Invalid price");
        markets[token] = Market(true, collateralFactor, price, 0, 0);
        marketList.push(token);
        emit MarketListed(token, collateralFactor, price);
    }

    /// @notice Update a market's price. Stands in for a Chainlink feed.
    function setPrice(address token, uint256 price) external onlyOwner {
        require(markets[token].listed, "Unknown market");
        require(price > 0, "Invalid price");
        markets[token].price = price;
        emit PriceUpdated(token, price);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Supply side: deposit / withdraw
    // ─────────────────────────────────────────────────────────────────────

    function deposit(address token, uint256 amount) external nonReentrant {
        require(markets[token].listed, "Unknown market");
        require(amount > 0, "Amount must be positive");

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        deposits[msg.sender][token] += amount;
        markets[token].totalSupplied += amount;
        emit Deposited(msg.sender, token, amount);
    }

    function withdraw(address token, uint256 amount) external nonReentrant {
        require(deposits[msg.sender][token] >= amount, "Insufficient deposit");
        require(availableLiquidity(token) >= amount, "Insufficient liquidity");

        deposits[msg.sender][token] -= amount;
        markets[token].totalSupplied -= amount;
        require(_isHealthy(msg.sender), "Withdrawal leaves position unhealthy");

        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Borrow side: borrow / repay
    // ─────────────────────────────────────────────────────────────────────

    function borrow(address token, uint256 amount) external nonReentrant {
        require(markets[token].listed, "Unknown market");
        require(amount > 0, "Amount must be positive");
        require(availableLiquidity(token) >= amount, "Insufficient liquidity");

        borrows[msg.sender][token] += amount;
        markets[token].totalBorrowed += amount;
        require(_isHealthy(msg.sender), "Borrow exceeds collateral");

        IERC20(token).safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, token, amount);
    }

    function repay(address token, uint256 amount) external nonReentrant {
        uint256 owed = borrows[msg.sender][token];
        require(owed > 0, "Nothing to repay");
        if (amount > owed) amount = owed; // clamp

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        borrows[msg.sender][token] -= amount;
        markets[token].totalBorrowed -= amount;
        emit Repaid(msg.sender, token, amount);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Liquidation
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Repay part of an underwater borrower's debt and seize their
    ///         collateral at a discount (a 5% bonus to the liquidator).
    function liquidate(address borrower, address repayToken, uint256 repayAmount, address seizeToken)
        external
        nonReentrant
    {
        require(!_isHealthy(borrower), "Borrower is healthy");
        require(borrows[borrower][repayToken] >= repayAmount, "Repay exceeds debt");
        require(repayAmount > 0, "Amount must be positive");

        // Value of debt repaid, in USD-1e18.
        uint256 repayValue = _value(repayToken, repayAmount);
        // Collateral to seize = repaid value + 5% bonus, converted to seizeToken units.
        uint256 seizeValue = (repayValue * (BASIS_POINTS + LIQUIDATION_BONUS)) / BASIS_POINTS;
        uint256 seizeAmount = (seizeValue * PRICE_SCALE) / markets[seizeToken].price;
        require(deposits[borrower][seizeToken] >= seizeAmount, "Insufficient collateral to seize");

        // Effects
        borrows[borrower][repayToken] -= repayAmount;
        markets[repayToken].totalBorrowed -= repayAmount;
        deposits[borrower][seizeToken] -= seizeAmount;
        markets[seizeToken].totalSupplied -= seizeAmount;

        // Interactions: liquidator pays the debt, receives the seized collateral.
        IERC20(repayToken).safeTransferFrom(msg.sender, address(this), repayAmount);
        IERC20(seizeToken).safeTransfer(msg.sender, seizeAmount);

        emit Liquidated(msg.sender, borrower, repayToken, repayAmount, seizeToken, seizeAmount);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Views: valuation & health
    // ─────────────────────────────────────────────────────────────────────

    /// @notice USD-1e18 value of `amount` of `token`.
    function _value(address token, uint256 amount) internal view returns (uint256) {
        return (amount * markets[token].price) / PRICE_SCALE;
    }

    /// @notice Borrowing power (Σ deposit value × collateral factor) in USD-1e18.
    function collateralValue(address user) public view returns (uint256 total) {
        for (uint256 i = 0; i < marketList.length; i++) {
            address token = marketList[i];
            uint256 d = deposits[user][token];
            if (d > 0) {
                total += (_value(token, d) * markets[token].collateralFactor) / BASIS_POINTS;
            }
        }
    }

    /// @notice Total debt value (Σ borrow value) in USD-1e18.
    function debtValue(address user) public view returns (uint256 total) {
        for (uint256 i = 0; i < marketList.length; i++) {
            address token = marketList[i];
            uint256 b = borrows[user][token];
            if (b > 0) total += _value(token, b);
        }
    }

    /// @notice Health factor in BPS: collateralValue / debtValue × 10000.
    ///         >= 10000 is safe; < 10000 is liquidatable. Max if no debt.
    function healthFactor(address user) public view returns (uint256) {
        uint256 debt = debtValue(user);
        if (debt == 0) return type(uint256).max;
        return (collateralValue(user) * BASIS_POINTS) / debt;
    }

    function _isHealthy(address user) internal view returns (bool) {
        return debtValue(user) <= collateralValue(user);
    }

    function isLiquidatable(address user) external view returns (bool) {
        return !_isHealthy(user);
    }

    function availableLiquidity(address token) public view returns (uint256) {
        Market storage m = markets[token];
        return m.totalSupplied - m.totalBorrowed;
    }

    function allMarkets() external view returns (address[] memory) {
        return marketList;
    }
}
