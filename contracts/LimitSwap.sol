// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;

import "./interfaces/ILimitSwap.sol";

contract LimitSwap is ILimitSwap {
    function createOrder(
        address token0,
        address token1,
        uint24 fee,
        bool zeroForOne,
        uint256 amountIn,
        uint160 targetSqrtPriceX96
    ) external override returns (uint256 orderId) {
        uint256 orderId = 0;
        emit OrderCreated(orderId);
        return orderId;
    }

    function closeOrder(uint256 orderId) external override {}
}
