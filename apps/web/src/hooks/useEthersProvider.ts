import { Web3Provider } from '@ethersproject/providers'
import { useAccount } from 'hooks/useAccount'
import { useMemo } from 'react'
import type { Chain, Client, Transport } from 'viem'
import { useClient, useConnectorClient } from 'wagmi'

// 使用 WeakMap 缓存 providers，以避免在每次渲染时都创建新的 provider
const providers = new WeakMap<Client, Web3Provider>()

/**
 * 将 viem 的 Client 实例转换为 ethers.js 的 Web3Provider。
 * @param client - viem 的 Client 实例。
 * @param chainId - 链 ID。
 * @returns 返回一个 ethers.js 的 Web3Provider 实例，如果 client 不存在则返回 undefined。
 */
export function clientToProvider(client?: Client<Transport, Chain>, chainId?: number) {
  if (!client) {
    return undefined
  }
  const { chain, transport } = client

  const ensAddress = chain.contracts?.ensRegistry?.address
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const network = chain
    ? {
        chainId: chain.id,
        name: chain.name,
        ensAddress,
      }
    : chainId
      ? { chainId, name: 'Unsupported' }
      : undefined
  if (!network) {
    return undefined
  }

  // 如果已经缓存了 provider，则直接返回
  if (providers.has(client)) {
    return providers.get(client)
  } else {
    // 否则，创建一个新的 provider 并缓存起来
    const provider = new Web3Provider(transport, network)
    providers.set(client, provider)
    return provider
  }
}

/** 
 * Hook，用于将 viem Client 转换为 ethers.js Provider，并提供一个默认的断开连接的网络回退。
 * @param {object} options - 选项对象。
 * @param {number} [options.chainId] - 链 ID。
 * @returns 返回一个 ethers.js Provider 实例。
 */
export function useEthersProvider({ chainId }: { chainId?: number } = {}) {
  const account = useAccount()
  const { data: client } = useConnectorClient({ chainId })
  const disconnectedClient = useClient({ chainId })
  return useMemo(
    () => clientToProvider(account.chainId !== chainId ? disconnectedClient : (client ?? disconnectedClient), chainId),
    [account.chainId, chainId, client, disconnectedClient],
  )
}

/** 
 * Hook，用于将一个已连接的 viem Client 转换为 ethers.js Provider。
 * @param {object} options - 选项对象。
 * @param {number} [options.chainId] - 链 ID。
 * @returns 返回一个 ethers.js Provider 实例。
 */
export function useEthersWeb3Provider({ chainId }: { chainId?: number } = {}) {
  const { data: client } = useConnectorClient({ chainId })
  return useMemo(() => clientToProvider(client, chainId), [chainId, client])
}
