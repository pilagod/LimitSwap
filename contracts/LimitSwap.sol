// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;
pragma abicoder v2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";

import "./interfaces/ILimitSwap.sol";

contract LimitSwap is ILimitSwap {
    using SafeERC20 for IERC20;

    address public immutable factory;
    address public immutable nonfungiblePositionManager;

    struct Order {
        address owner;
        address token0;
        address token1;
        uint24 fee;
        bool zeroForOne;
        uint128 liquidity;
    }
    mapping(uint256 => Order) public orderBook;

    constructor(address _factory, address _nonfungiblePositionManager) {
        factory = _factory;
        nonfungiblePositionManager = _nonfungiblePositionManager;
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
            token0,
            token1,
            fee,
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
            owner: msg.sender,
            token0: token0,
            token1: token1,
            fee: fee,
            zeroForOne: zeroForOne,
            liquidity: liquidity
        });

        emit OrderCreated(orderId);
    }

    function closeOrder(
        uint256 orderId
    ) external override returns (uint256 amount0, uint256 amount1) {
        Order memory order = orderBook[orderId];

        require(msg.sender == order.owner, "Not the owner");

        INonfungiblePositionManager.DecreaseLiquidityParams
            memory decreaseLiquidityParams = INonfungiblePositionManager
                .DecreaseLiquidityParams({
                    tokenId: orderId,
                    liquidity: order.liquidity,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: block.timestamp + 1 hours
                });
        INonfungiblePositionManager(nonfungiblePositionManager)
            .decreaseLiquidity(decreaseLiquidityParams);

        INonfungiblePositionManager.CollectParams
            memory collectParams = INonfungiblePositionManager.CollectParams({
                tokenId: orderId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            });
        (amount0, amount1) = INonfungiblePositionManager(
            nonfungiblePositionManager
        ).collect(collectParams);

        if (amount0 > 0) {
            IERC20(order.token0).safeTransfer(order.owner, amount0);
        }
        if (amount1 > 0) {
            IERC20(order.token1).safeTransfer(order.owner, amount1);
        }

        INonfungiblePositionManager(nonfungiblePositionManager).burn(orderId);
        delete orderBook[orderId];

        emit OrderClosed(orderId);
    }

    function getTickRange(
        address token0,
        address token1,
        uint24 fee,
        uint160 sqrtPriceX96
    ) internal view returns (int24 tickLower, int24 tickUpper) {
        IUniswapV3Pool pool = IUniswapV3Pool(
            PoolAddress.computeAddress(
                factory,
                PoolAddress.PoolKey(token0, token1, fee)
            )
        );
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

        return (tickLower, tickUpper);
    }
}
