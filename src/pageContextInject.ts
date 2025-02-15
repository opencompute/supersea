import {
  OpenSeaSDK,
  Network,
  orderFromJSON,
  assetFromJSON,
  deserializeOrder,
  EventType,
} from 'opensea-js'
import { RateLimit } from 'async-sema'
import { readableEthValue } from './utils/ethereum'
import { getLangAgnosticPath } from './utils/route'
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
        const order = event.data.params.order
        const openseaSDK = new OpenSeaSDK((window as any).ethereum, {
          networkName: Network.Main,
        })

        const _fulfillOrder = openseaSDK.seaport.fulfillOrder
        openseaSDK.seaport.fulfillOrder = async (...args: any) => {
          const returnValue = await _fulfillOrder.apply(
            openseaSDK.seaport,
            args,
          )
          returnValue.actions.forEach((action) => {
            const _transact = action.transactionMethods.transact
            action.transactionMethods.transact = (...args: any) => {
              args[0] = args[0] || {}
              if (event.data.params.gasPreset) {
                args[0].maxPriorityFeePerGas = Math.round(
                  event.data.params.gasPreset.priorityFee * 10 ** 9,
                ).toString()
                args[0].maxFeePerGas = Math.round(
                  event.data.params.gasPreset.fee * 10 ** 9,
                ).toString()
              }
              // Set custom gas limit to work around ethers.js estimation issues
              // TODO: May need tweaking
              args[0].gasLimit = 351523
              return _transact.apply(action.transactionMethods, args)
            }
          })
          return returnValue
        }

        if (
          event.data.params.displayedPrice &&
          Number(order.base_price || order.current_price) >
            Number(event.data.params.displayedPrice) * 1.1
        ) {
          throw new Error(
            `Transaction cancelled due to price change, the actual price was ${readableEthValue(
              order.base_price || order.current_price,
            )} ETH`,
          )
        }

        if (order.protocol_data.parameters.salt.length % 2) {
          order.protocol_data.parameters.salt =
            '0' + order.protocol_data.parameters.salt
        }

        openseaSDK.addListener(
          EventType.TransactionCreated,
          ({ transactionHash, event: _event }) => {
            window.postMessage({
              method: 'SuperSea__Buy__Sent',
              params: { ...event.data.params, transactionHash },
            })
          },
        )
        openseaSDK.addListener(
          EventType.TransactionDenied,
          ({ transactionHash, event: _event }) => {
            window.postMessage({
              method: 'SuperSea__Buy__Error',
              params: { ...event.data.params, transactionHash },
            })
          },
        )
        openseaSDK.addListener(
          EventType.TransactionFailed,
          ({ transactionHash, event: _event }) => {
            window.postMessage({
              method: 'SuperSea__Buy__Error',
              params: { ...event.data.params, transactionHash },
            })
          },
        )
        const transactionHash = await openseaSDK.fulfillOrder({
          order: deserializeOrder(order),
          accountAddress: await getEthAccount(),
        })
        window.postMessage({
          method: 'SuperSea__Buy__Success',
          params: { ...event.data.params, transactionHash },
        })
      } catch (error: any) {
        console.error(error)
        window.postMessage({
          method: 'SuperSea__Buy__Error',
          params: { ...event.data.params, error },
        })
      }
    } else if (event.data.method === 'SuperSea__Bid') {
      if (event.data.params.highestOffer > event.data.params.price) {
        window.postMessage({
          method: 'SuperSea__Bid__Skipped',
          params: { ...event.data.params, reason: 'outbid' },
        })
        return
      }

      try {
        await bidRateLimit()
        const openseaSDK = new OpenSeaSDK((window as any).ethereum, {
          networkName: Network.Main,
          apiKey: event.data.params.apiKey,
        })

        const postOrder = openseaSDK.api.postOrder
        openseaSDK.api.postOrder = async (...args) => {
          window.postMessage({
            method: 'SuperSea__Bid__Signed',
            params: { ...event.data.params },
          })
          return postOrder.apply(openseaSDK.api, args)
        }

        const getAsset = openseaSDK.api.getAsset.bind(openseaSDK)
        // @ts-ignore
        openseaSDK.api.getAsset = async (asset) => {
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
        await openseaSDK.createBuyOrder({
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
    } else if (event.data.method === 'SuperSea__RefreshPage') {
      window.next.router.replace(window.next.router.asPath)
    }
  })

  if (window.next && window.next.router) {
    window.next.router.events.on('routeChangeComplete', (url: string) => {
      document.body.dataset['superseaPath'] = getLangAgnosticPath()
      window.postMessage({
        method: 'SuperSea__Next__routeChangeComplete',
        params: { url: url, scrollY: window.scrollY },
      })
    })
    window.next.router.events.on('routeChangeStart', (url: string) => {
      document.body.dataset['superseaPath'] = ''
      window.postMessage({
        method: 'SuperSea__Next__routeChangeStart',
        params: { url: url, scrollY: window.scrollY },
      })
    })
  }
})(window)
