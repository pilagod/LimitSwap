// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;
pragma abicoder v2;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";
import "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";

import "./interfaces/ILimitSwap.sol";

contract LimitSwap is ILimitSwap {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    address public immutable factory;
    address public immutable nonfungiblePositionManager;

    struct Order {
        uint256 id;
        address owner;
        address token0;
        address token1;
        uint24 fee;
        bool zeroForOne;
        uint256 amount;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }
    mapping(uint256 => Order) public orderBook;

    constructor(address _factory, address _nonfungiblePositionManager) {
        factory = _factory;
        nonfungiblePositionManager = _nonfungiblePositionManager;
    }

    function getOrderFillAmount(
        uint256 orderId
    ) external view override returns (address token, uint256 amount) {
        Order memory order = orderBook[orderId];
        return getOrderFillAmount(order);
    }

    function createOrder(
        address token0,
        address token1,
        uint24 fee,
        bool zeroForOne,
        uint256 amountIn,
        uint160 sqrtPriceX96
    ) external override returns (uint256 orderId) {
        (int24 tickLower, int24 tickUpper) = getTickRange(
            getPool(token0, token1, fee),
            sqrtPriceX96
        );

        (uint256 amount0, uint256 amount1) = (0, 0);
        if (zeroForOne) {
            amount0 = amountIn;
            IERC20(token0).safeTransferFrom(
                msg.sender,
                address(this),
                amountIn
            );
            IERC20(token0).safeApprove(nonfungiblePositionManager, amountIn);
        } else {
            amount1 = amountIn;
            IERC20(token1).safeTransferFrom(
                msg.sender,
                address(this),
                amountIn
            );
            IERC20(token1).safeApprove(nonfungiblePositionManager, amountIn);
        }

        INonfungiblePositionManager.MintParams
            memory mintParams = INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: fee,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp + 1 hours
            });
        (uint256 tokenId, uint128 liquidity, , ) = INonfungiblePositionManager(
            nonfungiblePositionManager
        ).mint(mintParams);

        orderId = tokenId;
        orderBook[orderId] = Order({
            id: orderId,
            owner: msg.sender,
            token0: token0,
            token1: token1,
            fee: fee,
            zeroForOne: zeroForOne,
            amount: amountIn,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity
        });

        emit OrderCreated(orderId);
    }

    function fillOrder(
        uint256 orderId,
        uint256 amountMax
    ) external override returns (uint256 rebate0, uint256 rebate1) {
        Order memory order = orderBook[orderId];

        (address token, uint256 amountFill) = getOrderFillAmount(order);
        require(amountMax >= amountFill, "Not enough amount to fill order");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountFill);

        (uint256 amount0, uint256 amount1) = closeOrder(order);

        (uint160 sqrtPriceX96Lower, uint160 sqrtPriceX96Upper) = (
            TickMath.getSqrtRatioAtTick(order.tickLower),
            TickMath.getSqrtRatioAtTick(order.tickUpper)
        );
        if (order.zeroForOne) {
            uint256 amountOut = LiquidityAmounts.getAmount1ForLiquidity(
                sqrtPriceX96Lower,
                sqrtPriceX96Upper,
                order.liquidity
            );
            IERC20(order.token1).safeTransfer(order.owner, amountOut);

            (rebate0, rebate1) = (
                amount0,
                amount1.add(amountFill).sub(amountOut)
            );
        } else {
            uint256 amountOut = LiquidityAmounts.getAmount0ForLiquidity(
                sqrtPriceX96Lower,
                sqrtPriceX96Upper,
                order.liquidity
            );
            IERC20(order.token0).safeTransfer(order.owner, amountOut);

            (rebate0, rebate1) = (
                amount0.add(amountFill).sub(amountOut),
                amount1
            );
        }

        if (rebate0 > 0) {
            IERC20(order.token0).safeTransfer(msg.sender, rebate0);
        }
        if (rebate1 > 0) {
            IERC20(order.token1).safeTransfer(msg.sender, rebate1);
        }

        emit OrderFilled(orderId, rebate0, rebate1);
    }

    function closeOrder(
        uint256 orderId
    ) external override returns (uint256 amount0, uint256 amount1) {
        Order memory order = orderBook[orderId];

        require(msg.sender == order.owner, "Not the owner");

        (amount0, amount1) = closeOrder(order);

        if (amount0 > 0) {
            IERC20(order.token0).safeTransfer(order.owner, amount0);
        }
        if (amount1 > 0) {
            IERC20(order.token1).safeTransfer(order.owner, amount1);
        }
    }

    /* Internal */

    function getPool(
        address token0,
        address token1,
        uint24 fee
    ) internal view returns (IUniswapV3Pool pool) {
        return
            IUniswapV3Pool(
                PoolAddress.computeAddress(
                    factory,
                    PoolAddress.PoolKey(token0, token1, fee)
                )
            );
    }

    function getTickRange(
        IUniswapV3Pool pool,
        uint160 sqrtPriceX96
    ) internal view returns (int24 tickLower, int24 tickUpper) {
        int24 tick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
        int24 tickSpacing = pool.tickSpacing();

        tickLower = (tick / tickSpacing) * tickSpacing;
        tickUpper = tickLower + tickSpacing;

        (uint160 sqrtPriceX96Current, , , , , , ) = pool.slot0();
        require(
            TickMath.getSqrtRatioAtTick(tickLower) >= sqrtPriceX96Current ||
                TickMath.getSqrtRatioAtTick(tickUpper) <= sqrtPriceX96Current,
            "Invalid tick range"
        );
    }

    function getOrderFillAmount(
        Order memory order
    ) internal view returns (address token, uint256 amount) {
        IUniswapV3Pool pool = getPool(order.token0, order.token1, order.fee);
        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();
        (uint160 sqrtPriceX96Lower, uint160 sqrtPriceX96Upper) = (
            TickMath.getSqrtRatioAtTick(order.tickLower),
            TickMath.getSqrtRatioAtTick(order.tickUpper)
        );

        if (order.zeroForOne) {
            if (sqrtPriceX96 <= sqrtPriceX96Lower) {
                amount = LiquidityAmounts.getAmount1ForLiquidity(
                    sqrtPriceX96Lower,
                    sqrtPriceX96Upper,
                    order.liquidity
                );
            } else if (sqrtPriceX96 <= sqrtPriceX96Upper) {
                amount = LiquidityAmounts.getAmount1ForLiquidity(
                    sqrtPriceX96,
                    sqrtPriceX96Upper,
                    order.liquidity
                );
            } else {
                amount = 0;
            }

            return (order.token1, amount);
        }

        if (sqrtPriceX96 >= sqrtPriceX96Upper) {
            amount = LiquidityAmounts.getAmount0ForLiquidity(
                sqrtPriceX96Upper,
                sqrtPriceX96Lower,
                order.liquidity
            );
        } else if (sqrtPriceX96 >= sqrtPriceX96Lower) {
            amount = LiquidityAmounts.getAmount0ForLiquidity(
                sqrtPriceX96,
                sqrtPriceX96Lower,
                order.liquidity
            );
        } else {
            amount = 0;
        }

        return (order.token0, amount);
    }

    function closeOrder(
        Order memory order
    ) internal returns (uint256 amount0, uint256 amount1) {
        // Decreasing liquidity only updates accounting on the position manager
        INonfungiblePositionManager.DecreaseLiquidityParams
            memory decreaseLiquidityParams = INonfungiblePositionManager
                .DecreaseLiquidityParams({
                    tokenId: order.id,
                    liquidity: order.liquidity,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: block.timestamp + 1 hours
                });
        INonfungiblePositionManager(nonfungiblePositionManager)
            .decreaseLiquidity(decreaseLiquidityParams);

        // Collecting is the process to really settle the position and trigger token transfers
        INonfungiblePositionManager.CollectParams
            memory collectParams = INonfungiblePositionManager.CollectParams({
                tokenId: order.id,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            });
        (amount0, amount1) = INonfungiblePositionManager(
            nonfungiblePositionManager
        ).collect(collectParams);

        INonfungiblePositionManager(nonfungiblePositionManager).burn(order.id);
        delete orderBook[order.id];

        emit OrderClosed(order.id);
    }
}
