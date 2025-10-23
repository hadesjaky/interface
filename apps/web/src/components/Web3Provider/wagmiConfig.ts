// 导入币安钱包Wagmi连接器 v2
import { getWagmiConnectorV2 } from '@binance/w3w-wagmi-connector-v2'
// 导入Playwright测试环境中用于连接的地址常量
import { PLAYWRIGHT_CONNECT_ADDRESS } from 'components/Web3Provider/constants'
// 导入WalletConnect的参数配置
import { WC_PARAMS } from 'components/Web3Provider/walletConnect'
// 导入内嵌钱包连接器
import { embeddedWallet } from 'connection/EmbeddedWalletConnector'
// 导入Porto钱包的Wagmi配置
import { porto } from 'porto/wagmi'
// 导入Uniswap Logo资源
import { UNISWAP_LOGO } from 'ui/src/assets'
// 导入Uniswap Web应用的URL常量
import { UNISWAP_WEB_URL } from 'uniswap/src/constants/urls'
// 导入链信息获取函数和排序后的EVM链列表
import { getChainInfo, ORDERED_EVM_CHAINS } from 'uniswap/src/features/chains/chainInfo'
// 导入判断是否为测试网链的工具函数
import { isTestnetChain } from 'uniswap/src/features/chains/utils'
// 导入判断当前环境是否为Playwright或测试环境的工具函数
import { isPlaywrightEnv, isTestEnv } from 'utilities/src/environment/env'
// 导入日志记录器
import { logger } from 'utilities/src/logger/logger'
// 导入获取非空数组或抛出异常的工具函数
import { getNonEmptyArrayOrThrow } from 'utilities/src/primitives/array'
// 从viem库导入Chain类型和createClient函数
import { Chain, createClient } from 'viem'
// 从wagmi库导入配置相关的类型和函数
import { Config, createConfig, fallback, http } from 'wagmi'
// 从wagmi连接器中导入coinbaseWallet, mock, safe, walletConnect
import { coinbaseWallet, mock, safe, walletConnect } from 'wagmi/connectors'

// 初始化币安连接器
const BinanceConnector = getWagmiConnectorV2()

/**
 * 为给定的链生成一个有序的RPC URL传输列表。
 * 顺序为：interface -> default -> public -> fallback
 * @param chain 链信息对象
 * @returns 返回一个去重后的RPC URL字符串数组
 */
export const orderedTransportUrls = (chain: ReturnType<typeof getChainInfo>): string[] => {
  const orderedRpcUrls = [
    // 接口特定的RPC URL
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    ...(chain.rpcUrls.interface?.http ?? []),
    // 默认的RPC URL
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    ...(chain.rpcUrls.default?.http ?? []),
    // 公共的RPC URL
    ...(chain.rpcUrls.public?.http ?? []),
    // 备用的RPC URL
    ...(chain.rpcUrls.fallback?.http ?? []),
  ]

  // 过滤掉无效的URL并去重
  return Array.from(new Set(orderedRpcUrls.filter(Boolean)))
}

/**
 * 创建Wagmi连接器列表。
 * @param params 参数对象
 * @param params.includeMockConnector 如果为 `true`，则附加 wagmi `mock` 连接器。在 Playwright 中使用。
 * @returns 返回一个连接器实例数组
 */
function createWagmiConnectors(params: {
  /** 如果为 `true`，则附加 wagmi `mock` 连接器。在 Playwright 中使用。 */
  includeMockConnector: boolean
}): any[] {
  const { includeMockConnector } = params

  const baseConnectors = [
    // Porto 钱包连接器
    porto(),
    // 币安钱包连接器
    // 单元测试不期望包含 WalletConnect，
    // 因此我们可以禁用它以减少日志噪音。
    BinanceConnector({
      showQrCodeModal: true,
    }),
    // WalletConnect 连接器，在非Playwright的测试环境中禁用
    ...(isTestEnv() && !isPlaywrightEnv() ? [] : [walletConnect(WC_PARAMS)]),
    // 内嵌钱包连接器
    embeddedWallet(),
    // Coinbase 钱包连接器
    coinbaseWallet({
      appName: 'Uniswap',
      // Coinbase SDK 不会将父源上下文传递到其密钥网站
      // 已向 Coinbase 团队报告，修复后可移除 UNISWAP_WEB_URL
      appLogoUrl: `${UNISWAP_WEB_URL}${UNISWAP_LOGO}`,
      reloadOnDisconnect: false,
    }),
    // Safe (原Gnosis Safe) 钱包连接器
    safe(),
  ]

  // 如果需要，添加mock连接器用于测试
  return includeMockConnector
    ? [
        ...baseConnectors,
        mock({
          features: {},
          accounts: [PLAYWRIGHT_CONNECT_ADDRESS],
        }),
      ]
    : baseConnectors
}

/**
 * 创建Wagmi配置对象。
 * @param params 参数对象
 * @param params.connectors 要使用的连接器列表。
 * @param params.onFetchResponse 可选的自定义 `onFetchResponse` 处理器 – 默认为 `defaultOnFetchResponse`。
 * @returns 返回Wagmi的配置对象
 */
function createWagmiConfig(params: {
  /** 要使用的连接器列表。 */
  connectors: any[]
  /** 可选的自定义 `onFetchResponse` 处理器 – 默认为 `defaultOnFetchResponse`。 */
  onFetchResponse?: (response: Response, chain: Chain, url: string) => void
}): Config<typeof ORDERED_EVM_CHAINS> {
  const { connectors, onFetchResponse = defaultOnFetchResponse } = params

  return createConfig({
    // 设置支持的链
    chains: getNonEmptyArrayOrThrow(ORDERED_EVM_CHAINS),
    // 设置连接器
    connectors,
    // 为每个链创建Viem客户端
    client({ chain }) {
      return createClient({
        chain,
        // 启用批量处理multicall请求
        batch: { multicall: true },
        // 设置轮询间隔为12秒
        pollingInterval: 12_000,
        // 使用fallback机制来组织多个RPC URL，提高稳定性
        transport: fallback(
          orderedTransportUrls(chain).map((url) =>
            http(url, { onFetchResponse: (response) => onFetchResponse(response, chain, url) }),
          ),
        ),
      })
    },
  })
}

/**
 * 默认的RPC请求响应处理器。
 * 用于监控和记录RPC请求的失败情况。
 * @param response Fetch API的Response对象
 * @param chain 当前链对象
 * @param url 请求的RPC URL
 */
// eslint-disable-next-line max-params
const defaultOnFetchResponse = (response: Response, chain: Chain, url: string) => {
  if (response.status !== 200) {
    const message = `RPC provider returned non-200 status: ${response.status}`

    // 只对测试网链发出警告
    if (isTestnetChain(chain.id)) {
      logger.warn('wagmiConfig.ts', 'client', message, {
        extra: {
          chainId: chain.id,
          url,
        },
      })
    } else {
      // 记录主网链的错误，以便我们修复它们
      logger.error(new Error(message), {
        extra: {
          chainId: chain.id,
          url,
        },
        tags: {
          file: 'wagmiConfig.ts',
          function: 'client',
        },
      })
    }
  }
}

// 创建默认的连接器列表，根据环境决定是否包含mock连接器
const defaultConnectors = createWagmiConnectors({
  includeMockConnector: isPlaywrightEnv(),
})

// 创建并导出最终的Wagmi配置
export const wagmiConfig = createWagmiConfig({ connectors: defaultConnectors })

// 扩展wagmi模块的类型定义，将我们的配置注册进去
// 这使得在整个应用中可以方便地获得类型提示
declare module 'wagmi' {
  interface Register {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    config: typeof wagmiConfig
  }
}
