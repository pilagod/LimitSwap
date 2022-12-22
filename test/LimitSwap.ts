import assert from "assert"
import { expect } from "chai"
import { BigNumber, Signer } from "ethers"
import { ethers } from "hardhat"
import JSBI from "jsbi"
import {
    SnapshotRestorer,
    takeSnapshot,
} from "@nomicfoundation/hardhat-network-helpers"
import { Token } from "@uniswap/sdk-core"
import { FeeAmount, Pool, SqrtPriceMath } from "@uniswap/v3-sdk"
import { Network } from "~/network"
import { IERC20, ILimitSwap, IUniswapV3SwapRouter } from "~/typechain-types"
import { ContractUtil, Math, TokenMath } from "~/util"
import { dealToken } from "~/test/util"

describe("LimitSwap", () => {
    const USDC = new Token(Network.id, Network.address.USDC, 6, "USDC")
    const WETH = new Token(Network.id, Network.address.WETH, 18, "WETH")
    assert(
        BigNumber.from(USDC.address).lt(BigNumber.from(WETH.address)),
        "USDC requires to be token0",
    )

    let snapshot: SnapshotRestorer

    let operator: Signer
    let trader: Signer

    let usdc: IERC20
    let weth: IERC20

    let limitSwap: ILimitSwap
    let swapRouter: IUniswapV3SwapRouter

    before(async () => {
        ;[operator, trader] = await ethers.getSigners()

        usdc = await ethers.getContractAt("IERC20", USDC.address)
        weth = await ethers.getContractAt("IERC20", WETH.address)

        swapRouter = await ethers.getContractAt(
            "IUniswapV3SwapRouter",
            Network.address.Uniswap.SwapRouter,
        )
        const limitSwapFactory = await ethers.getContractFactory("LimitSwap")
        limitSwap = await limitSwapFactory.connect(operator).deploy()

        // Each user approves tokens to contracts
        for (const user of [operator, trader]) {
            for (const token of [usdc, weth]) {
                for (const contract of [limitSwap, swapRouter]) {
                    await token
                        .connect(user)
                        .approve(contract.address, ethers.constants.MaxUint256)
                }
            }
        }

        snapshot = await takeSnapshot()
    })

    beforeEach(async () => {
        await snapshot.restore()
    })

    it("should be able to fulfill order after price go through the order price", async () => {
        const pool0 = await getPool(USDC, WETH, FeeAmount.MEDIUM)

        const wethPriceStart = parseInt(pool0.priceOf(WETH).toFixed(0), 10)
        const wethPriceTarget = wethPriceStart - 1

        const targetSqrtPriceX96 = Math.sqrtX96(
            TokenMath.mul(1, WETH),
            TokenMath.mul(wethPriceTarget, USDC),
        )
        const usdcAmount = TokenMath.mul(wethPriceTarget, USDC)
        await dealToken(operator, usdc, usdcAmount.toString())

        // Open order to swap USDC to WETH at target price
        const openOrderTx = await limitSwap
            .connect(operator)
            .createOrder(
                USDC.address,
                WETH.address,
                FeeAmount.MEDIUM,
                true,
                usdcAmount.toString(),
                targetSqrtPriceX96.toString(),
            )
        const openOrderReceipt = await openOrderTx.wait()
        const [
            {
                args: { orderId },
            },
        ] = ContractUtil.parseEventLogsByName(
            limitSwap,
            "OrderCreated",
            openOrderReceipt.logs,
        )

        const pool1 = await getPool(USDC, WETH, FeeAmount.MEDIUM)

        const wethAmountToTargetPrice = SqrtPriceMath.getAmount1Delta(
            pool0.sqrtRatioX96,
            targetSqrtPriceX96,
            pool1.liquidity,
            true,
        )
        // Use double delta amount to ensure the order is filled
        const wethAmountToFillOrder = JSBI.multiply(
            wethAmountToTargetPrice,
            JSBI.BigInt(2),
        )
        await dealToken(trader, WETH, wethAmountToFillOrder.toString())

        // Swap WETH to USDC to fill order
        const swapTx = await swapRouter.connect(trader).exactInputSingle({
            tokenIn: WETH.address,
            tokenOut: USDC.address,
            fee: FeeAmount.MEDIUM,
            recipient: trader.getAddress(),
            deadline: Date.now(),
            amountIn: wethAmountToFillOrder.toString(),
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0,
        })
        await swapTx.wait()

        const closeOrderTx = await limitSwap
            .connect(operator)
            .closeOrder(orderId)
        await closeOrderTx.wait()

        const usdcBalance = await usdc.balanceOf(operator.getAddress())
        expect(usdcBalance).to.equal(0)
        console.log(
            `USDC balance: ${ethers.utils.formatUnits(
                usdcBalance,
                USDC.decimals,
            )}`,
        )

        const wethBalance = await weth.balanceOf(operator.getAddress())
        expect(
            parseInt(ethers.utils.formatEther(wethBalance), 10),
        ).to.be.approximately(1, 0.01)
        console.log(`WETH balance: ${ethers.utils.formatEther(wethBalance)}`)
    })

    it("playground", async () => {
        await dealToken(operator, weth, ethers.utils.parseEther("1000"))

        const pool = await getPool(USDC, WETH, FeeAmount.MEDIUM)

        const WETHPrice = parseInt(pool.priceOf(WETH).toFixed(0), 10)

        const currentSqrtX96 = pool.sqrtRatioX96
        const targetSqrtX96 = Math.sqrtX96(
            TokenMath.mul(1, WETH),
            TokenMath.mul(WETHPrice - 1, USDC),
        )
        console.log(`Current sqrt price: ${currentSqrtX96}`)
        console.log(`Target sqrt price: ${targetSqrtX96}`)

        const amount0 = SqrtPriceMath.getAmount0Delta(
            currentSqrtX96,
            targetSqrtX96,
            pool.liquidity,
            true,
        )
        const amount1 = SqrtPriceMath.getAmount1Delta(
            currentSqrtX96,
            targetSqrtX96,
            pool.liquidity,
            true,
        )
        console.log(`amount 0: ${amount0}`)
        console.log(`amount 1: ${amount1}`)

        await swapRouter.exactInputSingle({
            tokenIn: WETH.address,
            tokenOut: USDC.address,
            fee: FeeAmount.MEDIUM,
            recipient: operator.getAddress(),
            deadline: Date.now(),
            amountIn: amount1.toString(),
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0,
        })

        const poolAfterSwap = await getPool(WETH, USDC, FeeAmount.MEDIUM)

        console.log(`After swap sqrt price: ${poolAfterSwap.sqrtRatioX96}`)

        const usdcBalance = await usdc.balanceOf(operator.getAddress())
        console.log(`USDC balance: ${usdcBalance}`)

        const wethBalance = await weth.balanceOf(operator.getAddress())
        console.log(`WETH balance: ${wethBalance}`)
    })

    async function getPool(
        token0: Token,
        token1: Token,
        fee: FeeAmount,
    ): Promise<Pool> {
        const poolContract = await ethers.getContractAt(
            "IUniswapV3Pool",
            Pool.getAddress(token0, token1, fee),
        )
        const [liquidity, { sqrtPriceX96, tick }] = await Promise.all([
            poolContract.liquidity(),
            poolContract.slot0(),
        ])
        return new Pool(
            token0,
            token1,
            fee,
            sqrtPriceX96.toString(),
            liquidity.toString(),
            tick,
        )
    }
})
