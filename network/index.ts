import { network } from "hardhat"
import { Address as Address } from "./type"

const chainId = network.config.chainId ?? 0

export const Network = {
    id: chainId,
    name: network.name,
    address: getAddress(chainId),
}

function getAddress(chainId: number): Address {
    switch (chainId) {
        case 1:
            return require("./mainnet").default
        default:
            throw new Error(`Unknown chain id ${network.config.chainId}`)
    }
}
