import _ from 'lodash'
import { useEffect, useState, useRef } from 'react'
import { Button, Flex } from '@chakra-ui/react'
import Logo from '../Logo'
import ListingNotifierModal, { Notifier } from './ListingNotifierModal'
import { MatchedAsset } from './MatchedAssetListing'
import { readableEthValue, weiToEth } from '../../utils/ethereum'
import {
  fetchCollectionAddress,
  fetchIsRanked,
  fetchRaritiesWithTraits,
  fetchSelectors,
  Trait,
} from '../../utils/api'
import { determineRarityType, RARITY_TYPES } from '../../utils/rarity'
import { useUser } from '../../utils/user'

const POLL_INTERVAL_MS = 3000
const POLL_RETRIES = 15

const createPollTime = (bufferSeconds = 0) =>
  new Date(Date.now() - bufferSeconds * 1000).toISOString().replace(/Z$/, '')

type Rarities = {
  tokenRarity: Record<string, number>
  tokenCount: number
  isRanked: boolean
  traits: Trait[]
}

const listingMatchesNotifier = ({
  asset,
  notifier,
  rarities,
  assetsMatchingNotifier,
}: {
  asset: MatchedAsset
  notifier: Notifier
  rarities: Rarities | null
  assetsMatchingNotifier: Record<string, Record<string, boolean>>
}) => {
  // Auctions
  if (!notifier.includeAuctions && asset.currency === 'WETH') {
    return false
  }
  // Min Price
  if (
    notifier.minPrice !== null &&
    weiToEth(Number(asset.price)) < notifier.minPrice
  ) {
    return false
  }
  // Max Price
  if (
    notifier.maxPrice !== null &&
    weiToEth(Number(asset.price)) > notifier.maxPrice
  ) {
    return false
  }
  // Rarity
  if (notifier.lowestRarity !== 'Common' && rarities) {
    const rank = rarities.tokenRarity[asset.tokenId]
    if (rank !== undefined) {
      const assetRarity = determineRarityType(rank, rarities.tokenCount)
      const notifierRarityIndex = RARITY_TYPES.findIndex(
        ({ name }) => name === notifier.lowestRarity,
      )
      const assetRarityIndex = RARITY_TYPES.findIndex(
        ({ name }) => name === assetRarity.name,
      )
      if (assetRarityIndex > notifierRarityIndex) {
        return false
      }
    }
  }
  // Traits
  if (notifier.traits.length) {
    if (
      !assetsMatchingNotifier[notifier.id] ||
      !assetsMatchingNotifier[notifier.id][asset.tokenId]
    ) {
      return false
    }
  }
  return true
}

const throttledPlayNotificationSound = _.throttle(() => {
  const audio = new Audio(chrome.runtime.getURL('/notification.mp3'))
  audio.play()
}, 1000)

// Keep state cached so it's not lost when component is unmounted from
// switching event type filters on OpenSea
type CachedState = {
  collectionSlug: string
  assetsMatchingNotifier: Record<string, Record<string, boolean>>
  rarities: Rarities | null
  pollTime: string | null
  addedListings: Record<string, boolean>
  matchedAssets: MatchedAsset[]
  activeNotifiers: Notifier[]
  playSound: boolean
  sendNotification: boolean
}
let DEFAULT_STATE: CachedState = {
  collectionSlug: '',
  activeNotifiers: [],
  matchedAssets: [],
  addedListings: {},
  pollTime: null,
  rarities: null,
  assetsMatchingNotifier: {},
  playSound: true,
  sendNotification: true,
}
let cachedState = DEFAULT_STATE

const ListingNotifier = ({ collectionSlug }: { collectionSlug: string }) => {
  const [modalOpen, setModalOpen] = useState(false)

  const stateToRestore =
    cachedState.collectionSlug === collectionSlug ? cachedState : DEFAULT_STATE
  const [activeNotifiers, setActiveNotifiers] = useState<Notifier[]>(
    stateToRestore.activeNotifiers,
  )
  const [matchedAssets, setMatchedAssets] = useState<MatchedAsset[]>(
    stateToRestore.matchedAssets,
  )
  const addedListings = useRef<Record<string, boolean>>(
    stateToRestore.addedListings,
  ).current
  const pollTimeRef = useRef<string | null>(stateToRestore.pollTime)
  const [rarities, setRarities] = useState<Rarities | null>(
    stateToRestore.rarities,
  )
  const assetsMatchingNotifier = useRef<
    Record<string, Record<string, boolean>>
  >(stateToRestore.assetsMatchingNotifier).current

  const [playSound, setPlaySound] = useState(stateToRestore.playSound)
  const [sendNotification, setSendNotification] = useState(
    stateToRestore.sendNotification,
  )

  const [pollStatus, setPollStatus] = useState<
    'STARTING' | 'ACTIVE' | 'FAILED'
  >('STARTING')

  const retriesRef = useRef(0)

  const { isSubscriber } = useUser() || { isSubscriber: false }

  useEffect(() => {
    cachedState = {
      collectionSlug: collectionSlug,
      assetsMatchingNotifier: assetsMatchingNotifier,
      rarities,
      pollTime: pollTimeRef.current,
      addedListings,
      matchedAssets,
      activeNotifiers,
      playSound,
      sendNotification,
    }
  }, [
    activeNotifiers,
    addedListings,
    assetsMatchingNotifier,
    collectionSlug,
    matchedAssets,
    rarities,
    playSound,
    sendNotification,
  ])

  // Load rarities and traits
  // TODO: Check if member
  useEffect(() => {
    if (rarities) return
    ;(async () => {
      const address = await fetchCollectionAddress(collectionSlug)
      if (isSubscriber) {
        const rarities = await fetchRaritiesWithTraits(address, [])
        setRarities({
          tokenRarity: _.mapValues(
            _.keyBy(rarities.tokens, 'iteratorID'),
            'rank',
          ),
          tokenCount: rarities.tokenCount,
          isRanked: rarities.tokenCount > 0,
          traits: rarities.traits,
        })
      } else {
        const isRanked = await fetchIsRanked(address)
        setRarities({
          tokenRarity: {},
          tokenCount: 0,
          isRanked: Boolean(isRanked),
          traits: [],
        })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionSlug, rarities])

  // Set up polling
  useEffect(() => {
    let pollInterval: NodeJS.Timeout | null = null
    if (activeNotifiers.length === 0 || pollStatus === 'FAILED') {
      pollInterval !== null && clearInterval(pollInterval)
    } else {
      if (pollTimeRef.current === null) {
        pollTimeRef.current = createPollTime(5)
      }
      pollInterval = setInterval(async () => {
        chrome.storage.local.get(
          ['openSeaGraphQlRequests'],
          async ({ openSeaGraphQlRequests }) => {
            const request = openSeaGraphQlRequests['EventHistoryPollQuery']
            if (request) {
              const selectors = await fetchSelectors()
              const body = JSON.parse(request.body)
              body.variables = {
                ...body.variables,
                ...selectors.listingNotifier.api.staticVariables,
                [selectors.listingNotifier.api.variablePaths.collectionSlug]: [
                  collectionSlug,
                ],
                [selectors.listingNotifier.api.variablePaths.timestamp]:
                  pollTimeRef.current,
              }

              const nextPollTime = createPollTime(POLL_INTERVAL_MS / 1000 / 2)
              let fetchedAssets = null
              try {
                const res = await fetch(request.url, {
                  method: 'POST',
                  body: JSON.stringify(body),
                  headers: request.headers.reduce(
                    (
                      acc: Record<string, string>,
                      { name, value }: { name: string; value: string },
                    ) => {
                      if (value) {
                        acc[name] = value
                      }
                      return acc
                    },
                    {},
                  ),
                })
                const json = await res.json()
                pollTimeRef.current = nextPollTime
                const paths = selectors.listingNotifier.api.resultPaths
                fetchedAssets = _.get(json, paths.edges).map((edge: any) => {
                  if (!_.get(edge, paths.asset)) return null
                  return {
                    listingId: _.get(edge, paths.listingId),
                    tokenId: _.get(edge, paths.tokenId),
                    contractAddress: _.get(edge, paths.contractAddress),
                    name:
                      _.get(edge, paths.name) ||
                      _.get(edge, paths.collectionName),
                    image: _.get(edge, paths.image),
                    price: _.get(edge, paths.price),
                    currency: _.get(edge, paths.currency),
                    timestamp: _.get(edge, paths.timestamp),
                  }
                })
              } catch (e) {
                console.error('failed poll request', e)
                chrome.storage.local.remove(['openSeaGraphQlRequests'])
                retriesRef.current += 1
              }
              if (fetchedAssets) {
                const filteredAssets = fetchedAssets
                  .filter(Boolean)
                  .filter(
                    (asset: MatchedAsset) => !addedListings[asset.listingId],
                  )
                  .filter((asset: MatchedAsset) => {
                    const matches = activeNotifiers.some((notifier) =>
                      listingMatchesNotifier({
                        asset,
                        notifier,
                        rarities,
                        assetsMatchingNotifier,
                      }),
                    )
                    return matches
                  })
                filteredAssets.forEach((asset: MatchedAsset) => {
                  addedListings[asset.listingId] = true
                  if (sendNotification) {
                    chrome.runtime.sendMessage(
                      {
                        method: 'notify',
                        params: {
                          id: asset.listingId,
                          openOnClick: `https://opensea.io/assets/${asset.contractAddress}/${asset.tokenId}`,
                          options: {
                            title: 'SuperSea - New Listing',
                            type: 'basic',
                            iconUrl: asset.image,
                            requireInteraction: true,
                            silent: true,
                            message: `${asset.name} (${readableEthValue(
                              +asset.price,
                            )} ${asset.currency})`,
                          },
                        },
                      },
                      () => {
                        if (playSound) {
                          throttledPlayNotificationSound()
                        }
                      },
                    )
                  }
                })
                setPollStatus('ACTIVE')
                if (filteredAssets.length) {
                  setMatchedAssets((prev) => [...filteredAssets, ...prev])
                }
              }
            } else {
              // Retry n number of times before showing error
              retriesRef.current += 1
            }
            if (retriesRef.current >= POLL_RETRIES) {
              setPollStatus('FAILED')
            }
          },
        )
      }, POLL_INTERVAL_MS)
    }

    return () => {
      pollInterval && clearInterval(pollInterval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeNotifiers,
    collectionSlug,
    rarities,
    sendNotification,
    playSound,
    pollStatus,
  ])

  return (
    <Flex justifyContent="flex-end" py="2">
      <Button
        rightIcon={<Logo width="20px" height="20px" flipped />}
        iconSpacing="3"
        onClick={() => setModalOpen(true)}
      >
        Listing Notifiers
      </Button>
      <ListingNotifierModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        allTraits={rarities?.traits}
        isRanked={rarities ? rarities.isRanked : null}
        isSubscriber={isSubscriber}
        addedNotifiers={activeNotifiers}
        onAddNotifier={async (notifier) => {
          if (notifier.traits) {
            const address = await fetchCollectionAddress(collectionSlug)
            const { tokens } = await fetchRaritiesWithTraits(
              address,
              notifier.traits.map((val) => {
                const { groupName, value } = JSON.parse(val)
                return { key: groupName, value }
              }),
            )
            assetsMatchingNotifier[notifier.id] = tokens.reduce<
              Record<string, boolean>
            >((acc, { iteratorID }) => {
              acc[iteratorID] = true
              return acc
            }, {})
          }
          setActiveNotifiers((notifiers) => [...notifiers, notifier])
        }}
        onRemoveNotifier={(id) => {
          setActiveNotifiers((notifiers) =>
            notifiers.filter((n) => n.id !== id),
          )
          delete assetsMatchingNotifier[id]
        }}
        matchedAssets={matchedAssets}
        playSound={playSound}
        pollStatus={pollStatus}
        onChangePlaySound={setPlaySound}
        sendNotification={sendNotification}
        onChangeSendNotification={setSendNotification}
      />
    </Flex>
  )
}

export default ListingNotifier