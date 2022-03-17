import { OpenSeaPort, Network, orderFromJSON, assetFromJSON } from 'opensea-js'
import { RateLimit } from 'async-sema'
import { readableEthValue, weiToEth } from './utils/ethereum'
;((window: any) => {
  // Restore console for debugging
  // const i = document.createElement('iframe')
  // i.style.display = 'none'
  // document.body.appendChild(i)
  // window.console = (i.contentWindow as any).console

  const getEthAccount = async () => {
    const eth = (window as any).ethereum
    if (!eth) return null
    if (eth.selectedAddress) return eth.selectedAddress
    let accounts = await eth.request({ method: 'eth_accounts' })
    if (!accounts?.length) {
      accounts = await eth.request({
        method: 'eth_requestAccounts',
      })
    }
    if (accounts?.length) return accounts[0]
    return null
  }

  const bidRateLimit = RateLimit(1 / 3, { uniformDistribution: true })

  window.addEventListener('message', async (event: any) => {
    if (event.origin !== 'https://opensea.io') return
    if (event.data.method === 'SuperSea__Buy') {
      try {
        const order = event.data.params.listings[0]
        const seaport = new OpenSeaPort((window as any).ethereum, {
          networkName: Network.Main,
        })
        seaport.gasIncreaseFactor = 1.3
        // @ts-ignore
        const wyvernProtocol = seaport._getWyvernProtocolForOrder(order)
        const _sendTransactionAsync =
          wyvernProtocol.wyvernExchange.atomicMatch_.sendTransactionAsync

        if (event.data.params.gasPreset) {
          wyvernProtocol.wyvernExchange.atomicMatch_.sendTransactionAsync = (
            ...args: any
          ) => {
            args[args.length - 1].maxPriorityFeePerGas = (
              event.data.params.gasPreset.priorityFee *
              10 ** 9
            ).toString(16)
            args[args.length - 1].maxFeePerGas = (
              event.data.params.gasPreset.fee *
              10 ** 9
            ).toString(16)
            return _sendTransactionAsync.apply(
              (wyvernProtocol as any).wyvernExchange.atomicMatch_,
              args,
            )
          }
        }
        if (
          event.data.params.displayedPrice &&
          Number(order.base_price) > Number(event.data.params.displayedPrice)
        ) {
          throw new Error(
            `Transaction cancelled due to price change, the actual price was ${readableEthValue(
              order.base_price,
            )} ETH`,
          )
        }
        await seaport.fulfillOrder({
          order: orderFromJSON(order),
          accountAddress: await getEthAccount(),
        })
        window.postMessage({
          method: 'SuperSea__Buy__Success',
          params: { ...event.data.params },
        })
      } catch (error: any) {
        console.error(error)
        window.postMessage({
          method: 'SuperSea__Buy__Error',
          params: { ...event.data.params, error },
        })
      }
    } else if (event.data.method === 'SuperSea__Bid') {
      const highestOffer = event.data.params.offers.reduce(
        (acc: number, { current_price }: { current_price: string }) => {
          return Math.max(acc, weiToEth(Number(current_price)))
        },
        0,
      )

      if (highestOffer >= event.data.params.price) {
        window.postMessage({
          method: 'SuperSea__Bid__Skipped',
          params: { ...event.data.params, reason: 'outbid' },
        })
        return
      }

      try {
        await bidRateLimit()
        const seaport = new OpenSeaPort((window as any).ethereum, {
          networkName: Network.Main,
          apiKey: '2f6f419a083c46de9d83ce3dbe7db601',
        })

        const validateAndPostOrder = seaport.validateAndPostOrder.bind(seaport)
        seaport.validateAndPostOrder = async (orderWithSignature) => {
          window.postMessage({
            method: 'SuperSea__Bid__Signed',
            params: { ...event.data.params },
          })
          return validateAndPostOrder(orderWithSignature)
        }

        const getAsset = seaport.api.getAsset.bind(seaport)
        seaport.api.getAsset = async (asset) => {
          let returnedAsset = null
          if (asset.tokenId === event.data.params.tokenId) {
            returnedAsset = assetFromJSON(event.data.params.asset)
          } else {
            returnedAsset = await getAsset(asset)
          }
          // Fix for ERC-1155 tokens, see https://github.com/ProjectOpenSea/opensea-js/issues/385
          // Should be fixed in the next release of opensea-js
          returnedAsset.schemaName = returnedAsset.assetContract.schemaName
          return returnedAsset
        }
        await seaport.createBuyOrder({
          asset: {
            tokenId: event.data.params.tokenId,
            tokenAddress: event.data.params.address,
            schemaName: event.data.params.asset?.asset_contract?.schema_name,
          },
          accountAddress: await getEthAccount(),
          startAmount: event.data.params.price,
          expirationTime: event.data.params.expirationTime,
        })
        window.postMessage({
          method: 'SuperSea__Bid__Success',
          params: { ...event.data.params },
        })
      } catch (error: any) {
        console.error(error)
        window.postMessage({
          method: 'SuperSea__Bid__Error',
          params: { ...event.data.params, error },
        })
      }
    } else if (event.data.method === 'SuperSea__Navigate') {
      window.next.router.push(
        event.data.params.url,
        event.data.params.as,
        event.data.params.options,
      )
    } else if (event.data.method === 'SuperSea__GetEthAddress') {
      window.postMessage({
        method: 'SuperSea__GetEthAddress__Success',
        params: {
          ethAddress: await getEthAccount(),
        },
      })
    }
  })

  if (window.next && window.next.router) {
    window.next.router.events.on('routeChangeComplete', (url: string) => {
      window.postMessage({
        method: 'SuperSea__Next__routeChangeComplete',
        params: { url: url, scrollY: window.scrollY },
      })
    })
    window.next.router.events.on('routeChangeStart', (url: string) => {
      window.postMessage({
        method: 'SuperSea__Next__routeChangeStart',
        params: { url: url, scrollY: window.scrollY },
      })
    })
  }
})(window)
