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
    let marketMaker: Signer

    let usdc: IERC20
    let weth: IERC20

    let limitSwap: ILimitSwap
    let swapRouter: IUniswapV3SwapRouter

    before(async () => {
        ;[operator, trader, marketMaker] = await ethers.getSigners()

        usdc = await ethers.getContractAt("IERC20", USDC.address)
        weth = await ethers.getContractAt("IERC20", WETH.address)

        swapRouter = await ethers.getContractAt(
            "IUniswapV3SwapRouter",
            Network.address.Uniswap.SwapRouter,
        )
        const limitSwapFactory = await ethers.getContractFactory("LimitSwap")
        limitSwap = await limitSwapFactory
            .connect(operator)
            .deploy(
                Network.address.Uniswap.V3Factory,
                Network.address.Uniswap.NonfungiblePositionManager,
            )

        // Each user approves tokens to contracts
        for (const user of [operator, trader, marketMaker]) {
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

        console.log(
            `Initial pool price (USDC : WETH) = (${pool0
                .priceOf(WETH)
                .toFixed(2)} : 1)`,
        )
        const wethPriceTarget =
            parseInt(pool0.priceOf(WETH).toFixed(0), 10) - 10

        const usdcAmount = TokenMath.mul(wethPriceTarget, USDC)
        await dealToken(operator, usdc, usdcAmount.toString())

        const sqrtPriceX96Target = Math.sqrtX96(
            TokenMath.mul(1, WETH),
            TokenMath.mul(wethPriceTarget, USDC),
        )

        // Create order to swap USDC to WETH at target price
        console.log(
            `Operator creates order USDC (${ethers.utils.formatUnits(
                usdcAmount.toString(),
                USDC.decimals,
            )}) -> WETH at price (USDC : WETH) = (${wethPriceTarget} : 1)`,
        )
        const createOrderTx = await limitSwap
            .connect(operator)
            .createOrder(
                USDC.address,
                WETH.address,
                FeeAmount.MEDIUM,
                true,
                usdcAmount.toString(),
                sqrtPriceX96Target.toString(),
            )
        const createOrderReceipt = await createOrderTx.wait()
        const [
            {
                args: { orderId },
            },
        ] = ContractUtil.parseEventLogsByName(
            limitSwap,
            "OrderCreated",
            createOrderReceipt.logs,
        )

        const pool1 = await getPool(USDC, WETH, FeeAmount.MEDIUM)

        const wethAmountToTargetPrice = SqrtPriceMath.getAmount1Delta(
            pool0.sqrtRatioX96,
            sqrtPriceX96Target,
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
        console.log(
            `Trader swaps ${ethers.utils.formatEther(
                wethAmountToFillOrder.toString(),
            )} WETH to fill the order`,
        )
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

        const pool2 = await getPool(USDC, WETH, FeeAmount.MEDIUM)
        console.log(
            `Trader changes pool price (USDC : WETH) = (${pool2
                .priceOf(WETH)
                .toFixed(2)} : 1)`,
        )

        console.log(`Operator closes the order`)
        const closeOrderTx = await limitSwap
            .connect(operator)
            .closeOrder(orderId)
        await closeOrderTx.wait()

        const usdcBalance = await usdc.balanceOf(operator.getAddress())
        console.log(
            `Operator USDC balance: ${ethers.utils.formatUnits(
                usdcBalance,
                USDC.decimals,
            )}`,
        )
        expect(usdcBalance).to.equal(0)

        const wethBalance = await weth.balanceOf(operator.getAddress())
        console.log(
            `Operator WETH balance: ${ethers.utils.formatEther(wethBalance)}`,
        )
        expect(wethBalance).to.be.gte(ethers.utils.parseEther("1.003"))
    })

    it("should allow market maker to fill the order", async () => {
        const pool0 = await getPool(USDC, WETH, FeeAmount.MEDIUM)

        console.log(
            `Initial pool price (USDC : WETH) = (${pool0
                .priceOf(WETH)
                .toFixed(2)} : 1)`,
        )
        const wethPriceTarget =
            parseInt(pool0.priceOf(WETH).toFixed(0), 10) - 10

        const usdcAmount = TokenMath.mul(wethPriceTarget, USDC)
        await dealToken(operator, usdc, usdcAmount.toString())

        const sqrtPriceX96Target = Math.sqrtX96(
            TokenMath.mul(1, WETH),
            TokenMath.mul(wethPriceTarget, USDC),
        )

        // Create order to swap USDC to WETH at target price
        console.log(
            `Operator creates order USDC (${ethers.utils.formatUnits(
                usdcAmount.toString(),
                USDC.decimals,
            )}) -> WETH at price (USDC : WETH) = (${wethPriceTarget} : 1)`,
        )
        const createOrderTx = await limitSwap
            .connect(operator)
            .createOrder(
                USDC.address,
                WETH.address,
                FeeAmount.MEDIUM,
                true,
                usdcAmount.toString(),
                sqrtPriceX96Target.toString(),
            )
        const createOrderReceipt = await createOrderTx.wait()
        const [
            {
                args: { orderId },
            },
        ] = ContractUtil.parseEventLogsByName(
            limitSwap,
            "OrderCreated",
            createOrderReceipt.logs,
        )

        const pool1 = await getPool(USDC, WETH, FeeAmount.MEDIUM)

        const wethAmountToTargetPrice = SqrtPriceMath.getAmount1Delta(
            pool0.sqrtRatioX96,
            sqrtPriceX96Target,
            pool1.liquidity,
            true,
        )
        await dealToken(trader, WETH, wethAmountToTargetPrice.toString())

        // Swap WETH to USDC to partial fill the order
        console.log(
            `Trader swaps ${ethers.utils.formatEther(
                wethAmountToTargetPrice.toString(),
            )} WETH to partial fill the order`,
        )
        const swapTx = await swapRouter.connect(trader).exactInputSingle({
            tokenIn: WETH.address,
            tokenOut: USDC.address,
            fee: FeeAmount.MEDIUM,
            recipient: trader.getAddress(),
            deadline: Date.now(),
            amountIn: wethAmountToTargetPrice.toString(),
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0,
        })
        await swapTx.wait()

        const pool2 = await getPool(USDC, WETH, FeeAmount.MEDIUM)
        console.log(
            `Trader changes pool price (USDC : WETH) = (${pool2
                .priceOf(WETH)
                .toFixed(2)} : 1)`,
        )

        const { token, amount } = await limitSwap.getOrderFillAmount(orderId)
        assert(token == WETH.address, "Order should be filled by WETH")
        await dealToken(marketMaker, WETH, amount)

        console.log(
            `Market maker fills the order with ${ethers.utils.formatEther(
                amount,
            )} WETH`,
        )
        const fillOrderTx = await limitSwap
            .connect(marketMaker)
            .fillOrder(orderId, amount)
        const fillOrderReceipt = await fillOrderTx.wait()
        const [
            {
                args: { rebate0, rebate1 },
            },
        ] = ContractUtil.parseEventLogsByName(
            limitSwap,
            "OrderFilled",
            fillOrderReceipt.logs,
        )

        // Check operator balances
        {
            const usdcBalance = await usdc.balanceOf(operator.getAddress())
            console.log(
                `Operator USDC balance: ${ethers.utils.formatUnits(
                    usdcBalance,
                    USDC.decimals,
                )}`,
            )
            expect(usdcBalance).to.equal(0)

            const wethBalance = await weth.balanceOf(operator.getAddress())
            console.log(
                `Operator WETH balance: ${ethers.utils.formatEther(
                    wethBalance,
                )}`,
            )
            expect(wethBalance).to.be.gte(ethers.utils.parseEther("1"))
        }

        // Check market maker balances
        {
            const usdcBalance = await usdc.balanceOf(marketMaker.getAddress())
            console.log(
                `Market maker USDC balance: ${ethers.utils.formatUnits(
                    usdcBalance,
                    USDC.decimals,
                )}`,
            )
            expect(usdcBalance).to.equal(rebate0)

            const wethBalance = await weth.balanceOf(marketMaker.getAddress())
            console.log(
                `Market maker WETH balance: ${ethers.utils.formatEther(
                    wethBalance,
                )}`,
            )
            expect(wethBalance).to.equal(rebate1)
        }
    })

    it("playground", async () => {
        await dealToken(operator, weth, ethers.utils.parseEther("1000"))

        const pool = await getPool(USDC, WETH, FeeAmount.MEDIUM)

        const wethPrice = parseInt(pool.priceOf(WETH).toFixed(0), 10)

        const sqrtPriceX96Current = pool.sqrtRatioX96
        const sqrtPriceX96Target = Math.sqrtX96(
            TokenMath.mul(1, WETH),
            TokenMath.mul(wethPrice - 1, USDC),
        )
        console.log(`Current sqrt price: ${sqrtPriceX96Current}`)
        console.log(`Target sqrt price: ${sqrtPriceX96Target}`)

        const amount0 = SqrtPriceMath.getAmount0Delta(
            sqrtPriceX96Current,
            sqrtPriceX96Target,
            pool.liquidity,
            true,
        )
        const amount1 = SqrtPriceMath.getAmount1Delta(
            sqrtPriceX96Current,
            sqrtPriceX96Target,
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
