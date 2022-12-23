// SPDX-License-Identifier: MIT
pragma solidity >=0.7.0;

interface ILimitSwap {
    event OrderCreated(uint256 orderId);
    event OrderClosed(uint256 orderId);

    function createOrder(
        address token0, // Token whose address is smaller
        address token1, // Token whose address is larger
        uint24 fee, // Uniswap pool fee
        bool zeroForOne, // True when the order swaps from token0 to token1
        uint256 amountIn, // Token amount for the order to swap
        uint160 sqrtPriceX96 // Order price sqrt(token1 * (2 ** 192) / token0)
    ) external returns (uint256 orderId);

    function closeOrder(
        uint256 orderId
    ) external returns (uint256 amount0, uint256 amount1);
}
