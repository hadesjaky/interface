import { BigNumber } from '@ethersproject/bignumber'
import type { Percent } from '@uniswap/sdk-core'
import { TradeType } from '@uniswap/sdk-core'
import type { FlatFeeOptions } from '@uniswap/universal-router-sdk'
import type { FeeOptions } from '@uniswap/v3-sdk'
import { useAccount } from 'hooks/useAccount'
import type { PermitSignature } from 'hooks/usePermitAllowance'
import useSelectChain from 'hooks/useSelectChain'
import { useUniswapXSwapCallback } from 'hooks/useUniswapXSwapCallback'
import { useUniversalRouterSwapCallback } from 'hooks/useUniversalRouter'
import { useCallback } from 'react'
import { useMultichainContext } from 'state/multichain/useMultichainContext'
import type { InterfaceTrade } from 'state/routing/types'
import { OffchainOrderType, TradeFillType } from 'state/routing/types'
import { isClassicTrade, isUniswapXTrade } from 'state/routing/utils'
import { useAddOrder } from 'state/signatures/hooks'
import type { UniswapXOrderDetails } from 'state/signatures/types'
import { useTransaction, useTransactionAdder } from 'state/transactions/hooks'
import type { TransactionInfo } from 'state/transactions/types'
import { useSupportedChainId } from 'uniswap/src/features/chains/hooks/useSupportedChainId'
import { UniverseChainId } from 'uniswap/src/features/chains/types'
import { isEVMChain } from 'uniswap/src/features/platforms/utils/chains'
import { TransactionStatus, TransactionType } from 'uniswap/src/features/transactions/types/transactionDetails'
import { currencyId } from 'uniswap/src/utils/currencyId'

// SwapResult 类型定义
export type SwapResult = Awaited<ReturnType<ReturnType<typeof useSwapCallback>>>

// 通用路由费用字段类型定义
type UniversalRouterFeeField = { feeOptions: FeeOptions } | { flatFeeOptions: FlatFeeOptions }

/**
 * 获取通用路由器的费用字段。
 * @param trade - 交易对象。
 * @returns 返回通用路由器的费用字段，如果不是经典交易或没有交换费用，则返回 undefined。
 */
function getUniversalRouterFeeFields(trade?: InterfaceTrade): UniversalRouterFeeField | undefined {
  if (!isClassicTrade(trade)) {
    return undefined
  }
  if (!trade.swapFee) {
    return undefined
  }

  if (trade.tradeType === TradeType.EXACT_INPUT) {
    return { feeOptions: { fee: trade.swapFee.percent, recipient: trade.swapFee.recipient } }
  } else {
    return { flatFeeOptions: { amount: BigNumber.from(trade.swapFee.amount), recipient: trade.swapFee.recipient } }
  }
}

/**
 * 返回一个执行交换的函数，前提是所有参数都有效，并且用户已批准交易的经滑点调整后的输入金额。
 * @param {object} params - 参数对象。
 * @param {InterfaceTrade} [params.trade] - 要执行的交易。
 * @param {object} params.fiatValues - 输入、输出金额和费用的法定货币价值，用于分析记录。
 * @param {Percent} params.allowedSlippage - 允许的滑点（以 bips 为单位）。
 * @param {PermitSignature} [params.permitSignature] - 许可签名。
 * @returns 返回一个执行交换的异步函数。
 */
export function useSwapCallback({
  trade,
  fiatValues,
  allowedSlippage,
  permitSignature,
}: {
  trade?: InterfaceTrade // 要执行的交易
  fiatValues: { amountIn?: number; amountOut?: number; feeUsd?: number } // 输入、输出金额和费用的美元价值，用于分析记录
  allowedSlippage: Percent // 允许的滑点（以 bips 为单位）
  permitSignature?: PermitSignature
}) {
  const addTransaction = useTransactionAdder()
  const addOrder = useAddOrder()
  const account = useAccount()
  const supportedConnectedChainId = useSupportedChainId(account.chainId)
  const { chainId: swapChainId } = useMultichainContext()

  const uniswapXSwapCallback = useUniswapXSwapCallback({
    trade: isUniswapXTrade(trade) ? trade : undefined,
    allowedSlippage,
    fiatValues,
  })

  const universalRouterSwapCallback = useUniversalRouterSwapCallback({
    trade: isClassicTrade(trade) ? trade : undefined,
    fiatValues,
    options: {
      slippageTolerance: allowedSlippage,
      permit: permitSignature,
      ...getUniversalRouterFeeFields(trade),
    },
  })

  const selectChain = useSelectChain()
  const swapCallback = isUniswapXTrade(trade) ? uniswapXSwapCallback : universalRouterSwapCallback

  return useCallback(async () => {
    if (!trade) {
      throw new Error('缺少交易')
    } else if (!account.isConnected || !account.address) {
      throw new Error('钱包必须连接才能进行交换')
    } else if (!swapChainId) {
      throw new Error('缺少交换链 ID')
    } else if (!isEVMChain(swapChainId)) {
      throw new Error('在旧版限制流程中使用了非 EVM 链')
    } else if (!supportedConnectedChainId || supportedConnectedChainId !== swapChainId) {
      const correctChain = await selectChain(swapChainId)
      if (!correctChain) {
        throw new Error('钱包必须连接到正确的链才能进行交换')
      }
    }
    const result = await swapCallback()

    const swapInfo: TransactionInfo = {
      type: TransactionType.Swap,
      inputCurrencyId: currencyId(trade.inputAmount.currency),
      outputCurrencyId: currencyId(trade.outputAmount.currency),
      isUniswapXOrder: result.type === TradeFillType.UniswapX || result.type === TradeFillType.UniswapXv2,
      ...(trade.tradeType === TradeType.EXACT_INPUT
        ? {
            tradeType: TradeType.EXACT_INPUT,
            inputCurrencyAmountRaw: trade.inputAmount.quotient.toString(),
            expectedOutputCurrencyAmountRaw: trade.outputAmount.quotient.toString(),
            minimumOutputCurrencyAmountRaw: trade.minimumAmountOut(allowedSlippage).quotient.toString(),
          }
        : {
            tradeType: TradeType.EXACT_OUTPUT,
            maximumInputCurrencyAmountRaw: trade.maximumAmountIn(allowedSlippage).quotient.toString(),
            outputCurrencyAmountRaw: trade.outputAmount.quotient.toString(),
            expectedInputCurrencyAmountRaw: trade.inputAmount.quotient.toString(),
          }),
    }

    switch (result.type) {
      case TradeFillType.UniswapX:
      case TradeFillType.UniswapXv2:
        addOrder({
          offerer: account.address,
          orderHash: result.response.orderHash,
          chainId: supportedConnectedChainId as UniverseChainId, // 满足类型检查器；如果 !supportedConnectedChainId，则已在上面检查并切换链
          expiry: result.response.deadline,
          swapInfo: swapInfo as UniswapXOrderDetails['swapInfo'],
          encodedOrder: result.response.encodedOrder,
          offchainOrderType: isUniswapXTrade(trade) ? trade.offchainOrderType : OffchainOrderType.DUTCH_AUCTION, // 满足类型检查器；isUniswapXTrade 应始终为 true
        })
        break
      default:
        addTransaction(result.response, swapInfo, result.deadline?.toNumber())
    }

    return result
  }, [
    account.address,
    account.isConnected,
    addOrder,
    addTransaction,
    allowedSlippage,
    selectChain,
    supportedConnectedChainId,
    swapCallback,
    swapChainId,
    trade,
  ])
}

/**
 * Hook，用于获取交换交易的状态。
 * @param swapResult - 交换结果。
 * @returns 返回交易状态，如果找不到交易则返回 undefined。
 */
export function useSwapTransactionStatus(swapResult: SwapResult | undefined): TransactionStatus | undefined {
  const transaction = useTransaction(swapResult?.type === TradeFillType.Classic ? swapResult.response.hash : undefined)
  if (!transaction) {
    return undefined
  }
  return transaction.status
}
