import JSBI from "jsbi"
import { BigintIsh, Token, sqrt } from "@uniswap/sdk-core"
import { Q192 } from "~/constant"

export class Math {
    public static sqrtX96(nominator: BigintIsh, denominator: BigintIsh): JSBI {
        return sqrt(
            JSBI.divide(
                JSBI.multiply(JSBI.BigInt(nominator), Q192),
                JSBI.BigInt(denominator),
            ),
        )
    }
}

export class TokenMath {
    public static mul(value: BigintIsh, token: Token) {
        return JSBI.multiply(
            JSBI.BigInt(value),
            JSBI.exponentiate(JSBI.BigInt(10), JSBI.BigInt(token.decimals)),
        )
    }
}
