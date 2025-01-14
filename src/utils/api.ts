import DataLoader from 'dataloader'
import { request, gql, GraphQLClient } from 'graphql-request'
import { fetchMetadataUri } from '../utils/web3'
import { RateLimit, Sema } from 'async-sema'
import { User } from './user'
import _ from 'lodash'
import { RemoteConfigs } from '../hooks/useRemoteConfig'

const fallbacks: Record<Marketplace, { config: any; styles: string }> = {
  opensea: {
    config: require('../assets/fallbacks/opensea/config.json'),
    styles: '',
  },
  sudoswap: {
    config: require('../assets/fallbacks/sudoswap/config.json'),
    styles: '',
  },
  gem: {
    config: require('../assets/fallbacks/gem/config.json'),
    styles: '',
  },
}

const configVersionAffixes: Record<Marketplace, string> = {
  opensea: '_v2',
  sudoswap: '',
  gem: '',
}

// Parcel will inline the string
try {
  const fs = require('fs')
  fallbacks.opensea.styles = fs.readFileSync(
    './src/assets/fallbacks/opensea/styles.css',
    'utf-8',
  )
  fallbacks.sudoswap.styles = fs.readFileSync(
    './src/assets/fallbacks/sudoswap/styles.css',
    'utf-8',
  )
  fallbacks.gem.styles = fs.readFileSync(
    './src/assets/fallbacks/gem/styles.css',
    'utf-8',
  )
} catch (err) {}

const OPENSEA_SHARED_CONTRACT_ADDRESSES = [
  '0x495f947276749ce646f68ac8c248420045cb7b5e',
  '0x2953399124f0cbb46d2cbacd8a89cf0599974963',
]
// Not exactly right but good enough to split tokenIds into their unique collections
const OPENSEA_SHARED_CONTRACT_COLLECTION_ID_LENGTH = 60

const ART_BLOCKS_ADDRESS = '0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270'

const ART_BLOCKS_TOKEN_ID_LENGTH = 6

export type Marketplace = 'opensea' | 'sudoswap' | 'gem'

export type Rarities = {
  tokenCount: number
  totalSupply: number | null
  rankWarning: string | null
  tokens: {
    iteratorID: number | string
    rank: number
    noTraitCountRank: number
  }[]
}

export type Trait = {
  count: number
  trait_type: string
  value: string
}

export type RaritiesWithTraits = Rarities & {
  rankingOptions: {
    excludeTraits: string[]
  }
  traits: Trait[]
}

export type Floor = {
  price: number
  floorSearchUrl: string
  currency: string
}

export type AssetInfo = {
  relayId: string
  tokenMetadata: string
}

export type Asset = {
  id: number
  token_id: string
  asset_contract: {
    address: string
    image_url: string
  }
  name: string
  collection: {
    name: string
  }
  image_url: string
  last_sale?: {
    total_price: string
    payment_token: {
      symbol: 'ETH' | 'WETH'
    }
  }
  sell_orders:
    | {
        current_price: string
        base_price: string
        payment_token_contract: {
          symbol: 'ETH' | 'WETH'
        }
      }[]
    | null
  seaport_sell_orders:
    | {
        current_price: string
        order_type: string
      }[]
    | null
}

export type Collection = {
  name: string
  slug: string
  image_url: string
  created_date: string
  primary_asset_contracts: { address: string }[]
  dev_seller_fee_basis_points: number
  stats: {
    average_price: number
    count: number
    floor_price: number
    market_cap: number
    num_owners: number
    num_reports: number
    one_day_average_price: number
    one_day_change: number
    one_day_sales: number
    one_day_volume: number
    seven_day_average_price: number
    seven_day_change: number
    seven_day_sales: number
    seven_day_volume: number
    thirty_day_average_price: number
    thirty_day_change: number
    thirty_day_sales: number
    thirty_day_volume: number
    total_sales: number
    total_supply: number
    total_volume: number
  }
}

export type Chain = 'ethereum' | 'polygon'

const REMOTE_ASSET_BASE = 'https://nonfungible.tools/supersea'
const GRAPHQL_AUTH_URL =
  window.localStorage.GRAPHQL_AUTH_URL ||
  'https://api.nonfungible.tools/graphql'
const GRAPHQL_CDN_URL =
  window.localStorage.GRAPHQL_CDN_URL ||
  'https://supersea-worker.supersea.workers.dev/graphql'

export const OPENSEA_ASSETS_BATCH_SIZE = 30

const openSeaPublicRateLimit = RateLimit(2)

let remoteConfigPromise: null | Promise<RemoteConfigs[Marketplace]> = null

export const fetchRemoteConfig = <T extends Marketplace = 'opensea'>(
  marketplace: T = 'opensea' as T,
): Promise<RemoteConfigs[T]> => {
  if (!remoteConfigPromise) {
    // Fallback to last known selectors if request takes more than 5 seconds
    remoteConfigPromise = Promise.race<Promise<RemoteConfigs[Marketplace]>>([
      fetch(
        `${REMOTE_ASSET_BASE}/${marketplace}/config${configVersionAffixes[marketplace]}.json`,
      ).then((res) => res.json()),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), 5000)
      }),
    ]).catch((err) => {
      console.error(err)
      return fallbacks[marketplace].config as RemoteConfigs[T]
    })
  }

  return remoteConfigPromise as Promise<RemoteConfigs[T]>
}

let cssPromise: null | Promise<string> = null
export const fetchGlobalCSS = (
  marketplace: keyof typeof fallbacks = 'opensea',
) => {
  if (!cssPromise) {
    // Fallback to last known css if request takes more than 5 seconds
    cssPromise = Promise.race<Promise<string>>([
      fetch(`${REMOTE_ASSET_BASE}/${marketplace}/styles.css`).then((res) => {
        if (res.status !== 200) throw new Error('failed to fetch styles')
        return res.text()
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), 5000)
      }),
    ]).catch((err) => {
      console.error(err)
      return fallbacks[marketplace].styles
    })
  }
  return cssPromise
}

const refreshTokenQuery = gql`
  mutation RefreshToken {
    refreshToken {
      success
      accessToken
      account {
        role
        membershipType
      }
    }
  }
`

const tokenClient = new GraphQLClient(GRAPHQL_AUTH_URL, {
  credentials: 'include',
  mode: 'cors',
})

const userSema = new Sema(1)
let cachedUser:
  | {
      accessToken: string
      role: User['role']
      membershipType: User['membershipType']
    }
  | null
  | undefined = undefined

export const getUser = async (refresh = false) => {
  await userSema.acquire()
  if (!refresh) {
    if (cachedUser !== undefined) {
      userSema.release()
      return cachedUser
    }
  }
  const {
    refreshToken: { accessToken, account },
  } = await tokenClient.request(refreshTokenQuery)

  cachedUser = {
    accessToken,
    role: account?.role || 'FREE',
    membershipType: account?.membershipType,
  }
  userSema.release()

  return cachedUser
}

const getUserRoleHeader = (
  role: User['role'],
  membershipType: User['membershipType'],
) => {
  return `${role}-${membershipType}` as const
}

const nonFungibleRequest = async (
  query: any,
  variables: any = {},
  refreshAccessToken = false,
  url = GRAPHQL_CDN_URL,
): Promise<any> => {
  const user = await getUser(refreshAccessToken)
  const accessToken = user?.role !== 'FREE' && user?.accessToken
  try {
    const res = await request(
      url,
      query,
      variables,
      accessToken
        ? {
            Authorization: accessToken,
            'X-NonFungibleTools-Role': getUserRoleHeader(
              user.role,
              user.membershipType,
            ),
            'X-SuperSea-Path': window.location.pathname,
          }
        : {},
    )
    return res
  } catch (err: any) {
    if (
      err?.response?.errors[0]?.message === 'Not Authorised!' &&
      !refreshAccessToken
    ) {
      return nonFungibleRequest(query, variables, true)
    }
    throw err
  }
}

export const floorPriceLoader = new DataLoader(
  async (keys: readonly string[]) => {
    const [slug] = keys
    await openSeaPublicRateLimit()
    const { stats } = await fetch(
      `https://api.opensea.io/api/v1/collection/${slug}/stats?v=${Date.now()}`,
    ).then((res) => res.json())
    return [
      {
        price: Math.round(stats.floor_price * 10000) / 10000,
        floorSearchUrl: `https://opensea.io/collection/${slug}?search[sortAscending]=true&search[sortBy]=PRICE&search[toggles][0]=BUY_NOW`,
        currency: 'ETH',
      },
    ]
  },
  {
    maxBatchSize: 1,
  },
)

export const fetchFloorPrice = (collectionSlug: string) => {
  return floorPriceLoader.load(collectionSlug) as Promise<Floor>
}

const rarityQuery = gql`
  query RarityQuery($address: String!) {
    contract(address: $address) {
      contractAddress
      tokenCount
      totalSupply
      rankWarning
      tokens {
        iteratorID
        rank
        noTraitCountRank
      }
    }
  }
`

const rarityLoader = new DataLoader(
  async (addresses: readonly string[]) => {
    // Max batch size is 1, we only use this for client side caching
    const address = addresses[0]
    try {
      const res = await nonFungibleRequest(rarityQuery, {
        address,
      })
      return [res.contract]
    } catch (e) {
      return [null]
    }
  },
  {
    batchScheduleFn: (callback) => setTimeout(callback, 250),
    maxBatchSize: 1,
  },
)

const rarityTraitQuery = gql`
  query RarityTraitQuery($address: String!, $input: TokenInputType) {
    contract(address: $address) {
      contractAddress
      tokenCount
      traits {
        count
        trait_type
        value
      }
      rankingOptions {
        excludeTraits
      }
      tokens(input: $input) {
        iteratorID
        rank
        noTraitCountRank
      }
    }
  }
`

const rarityTraitQueryAllTokens = gql`
  query RarityTraitQueryAllTokens($address: String!) {
    contract(address: $address) {
      contractAddress
      tokenCount
      traits {
        count
        trait_type
        value
      }
      rankingOptions {
        excludeTraits
      }
      tokens {
        iteratorID
        rank
        noTraitCountRank
      }
    }
  }
`

export const fetchRarities = async (address: string) => {
  return rarityLoader.load(address) as Promise<Rarities>
}

export const fetchRaritiesWithTraits = async (
  address: string,
  traits: { key: string; value: string }[],
) => {
  const res = traits.length
    ? await nonFungibleRequest(rarityTraitQuery, {
        address,
        input: { traits },
      })
    : await nonFungibleRequest(rarityTraitQueryAllTokens, { address })

  return res.contract as RaritiesWithTraits
}

const isRankedQuery = gql`
  query IsRankedQuery($address: String!) {
    contract(address: $address) {
      contractAddress
      isRanked
    }
  }
`

const isRankedLoader = new DataLoader(
  async (addresses: readonly string[]) => {
    // Max batch size is 1, we only use this for client side caching
    const address = addresses[0]
    try {
      const res = await nonFungibleRequest(isRankedQuery, {
        address,
      })
      return [res.contract.isRanked]
    } catch (e) {
      return [null]
    }
  },
  {
    batchScheduleFn: (callback) => setTimeout(callback, 250),
    maxBatchSize: 1,
  },
)

export const fetchIsRanked = async (address: string) => {
  return isRankedLoader.load(address) as Promise<boolean>
}

const assetLoader = new DataLoader(
  async (
    keys: readonly {
      collectionSlug: string
      tokenId: string
    }[],
  ) => {
    // Assume all are for the same address for now
    const slug = keys[0].collectionSlug
    const tokenIds = keys.map(({ tokenId }) => tokenId)
    await openSeaPublicRateLimit()
    const res = await fetch(
      `https://api.opensea.io/api/v1/assets?collection_slug=${slug}&limit=${OPENSEA_ASSETS_BATCH_SIZE}&include_orders=true&token_ids=${tokenIds.join(
        '&token_ids=',
      )}`,
    ).then((res) => res.json())
    return keys.map(({ tokenId }) => {
      if (!res) return null
      const asset = res.assets.find(
        ({ token_id }: { token_id: string }) => token_id === tokenId,
      )
      if (!asset) return null
      return asset
    })
  },
  {
    batchScheduleFn: (callback) => setTimeout(callback, 500),
    maxBatchSize: OPENSEA_ASSETS_BATCH_SIZE,
  },
)

export const fetchAssetBatched = (collectionSlug: string, tokenId: string) => {
  return assetLoader.load({ collectionSlug, tokenId }) as Promise<Asset>
}

export const fetchListings = async (address: string, tokenId: string) => {
  await openSeaPublicRateLimit()
  return fetch(
    `https://api.opensea.io/api/v1/asset/${address}/${tokenId}/listings`,
  ).then((res) => res.json())
}

export const fetchOffers = async (
  address: string,
  tokenId: string,
): Promise<{
  offers: { current_price: string }[]
  seaport_offers: { current_price: string }[]
}> => {
  await openSeaPublicRateLimit()
  return fetch(
    `https://api.opensea.io/api/v1/asset/${address}/${tokenId}/offers`,
  ).then((res) => res.json())
}

export const fetchAssets = async (
  collectionSlug: string,
  cursor?: string | null,
): Promise<{ assets: Asset[]; next: string | null }> => {
  await openSeaPublicRateLimit()
  return fetch(
    `https://api.opensea.io/api/v1/assets?collection_slug=${collectionSlug}&include_orders=true&order_direction=asc&limit=${OPENSEA_ASSETS_BATCH_SIZE}${
      cursor ? `&cursor=${cursor}` : ''
    }`,
  )
    .then((res) => res.json())
    .then((res) => {
      // Correct weird OpenSea behaviour with order_direction=asc
      return {
        ...res,
        assets: res.assets.sort(
          (a: any, b: any) => Number(a.token_id) - Number(b.token_id),
        ),
        next: res.previous,
      }
    })
}

export const fetchAllCollectionsForUser = async (
  address: string,
  list = [],
  offset = 0,
): Promise<
  { slug: string; ownedCount: number; name: string; image: string }[]
> => {
  await openSeaPublicRateLimit()
  const collections = await fetch(
    `https://api.opensea.io/api/v1/collections?asset_owner=${address}&offset=${offset}&limit=300`,
  ).then((res) => res.json())
  const updatedList = list.concat(
    collections.map(
      (collection: {
        slug: string
        owned_asset_count: number
        name: string
        image_url: string
      }) => {
        return {
          slug: collection.slug,
          name: collection.name,
          image: collection.image_url,
          ownedCount: collection.owned_asset_count,
        }
      },
    ),
  )
  if (collections.length === 300) {
    return fetchAllCollectionsForUser(address, updatedList, offset + 300)
  } else {
    return updatedList
  }
}

export const fetchCollectionAssetsForUser = async (
  {
    walletAddress,
    contractAddress,
  }: {
    walletAddress: string
    contractAddress: string
  },
  list = [],
  cursor?: string,
): Promise<Asset[]> => {
  await openSeaPublicRateLimit()
  const data = await fetch(
    `https://api.opensea.io/api/v1/assets?owner=${walletAddress}&asset_contract_address=${contractAddress}&limit=50`,
  ).then((res) => res.json())
  if (data.next) {
    return fetchCollectionAssetsForUser(
      { walletAddress, contractAddress },
      list.concat(data.assets),
      data.next,
    )
  }
  return list.concat(data.assets)
}

export const fetchMetadataUriWithOpenSeaFallback = async (
  address: string,
  tokenId: number,
) => {
  let contractTokenUri = await fetchMetadataUri(address, tokenId)
  if (!contractTokenUri) {
    await openSeaPublicRateLimit()
    const asset = await fetch(
      `https://api.opensea.io/api/v1/asset/${address}/${tokenId}`,
    ).then((res) => res.json())
    contractTokenUri = asset.token_metadata
  }
  return contractTokenUri.replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/')
}

export const triggerOpenSeaMetadataRefresh = async (
  address: string,
  tokenId: string,
) => {
  await openSeaPublicRateLimit()
  return fetch(
    `https://api.opensea.io/api/v1/asset/${address}/${tokenId}/?force_update=true`,
  )
}

const collectionAddressLoader = new DataLoader(
  async (slugs: readonly string[]) => {
    // Max batch size is 1, we only use this for client side caching
    const slug = slugs[0]
    try {
      await openSeaPublicRateLimit()
      const data = await fetch(
        `https://api.opensea.io/api/v1/assets?limit=1&collection=${slug}`,
      ).then((res) => res.json())
      return [data.assets[0].asset_contract.address]
    } catch (e) {
      return [null]
    }
  },
  {
    batchScheduleFn: (callback) => setTimeout(callback, 250),
    maxBatchSize: 1,
  },
)

const collectionLoader = new DataLoader(
  async (slugs: readonly string[]) => {
    // Max batch size is 1, we only use this for client side caching
    const slug = slugs[0]
    try {
      await openSeaPublicRateLimit()
      const data = await fetch(
        `https://api.opensea.io/api/v1/collection/${slug}`,
      ).then((res) => res.json())
      return [data.collection]
    } catch (e) {
      return [null]
    }
  },
  {
    batchScheduleFn: (callback) => setTimeout(callback, 250),
    maxBatchSize: 1,
  },
)

export const fetchCollectionAddress = async (
  slug: string,
  tryCollectionLoader = true,
) => {
  if (tryCollectionLoader) {
    const collection = await collectionLoader.load(slug)
    if (collection.primary_asset_contracts[0]) {
      return collection.primary_asset_contracts[0].address as string
    }
  }
  return collectionAddressLoader.load(slug) as Promise<string>
}

export const fetchCollection = async (slug: string) => {
  return collectionLoader.load(slug) as Promise<Collection>
}

const collectionSlugLoader = new DataLoader(
  async (
    keys: readonly {
      address: string
      tokenId: string
    }[],
  ) => {
    const { address, tokenId } = keys[0]
    await openSeaPublicRateLimit()
    const asset = await fetch(
      `https://api.opensea.io/api/v1/asset/${address}/${tokenId}`,
    ).then((res) => res.json())
    return [asset.collection.slug]
  },
  {
    maxBatchSize: 1,
    cacheKeyFn: ({ address, tokenId }) => {
      if (OPENSEA_SHARED_CONTRACT_ADDRESSES.includes(address)) {
        return `${address}/${tokenId.slice(
          0,
          OPENSEA_SHARED_CONTRACT_COLLECTION_ID_LENGTH,
        )}`
      } else if (ART_BLOCKS_ADDRESS === address) {
        return `${address}/${tokenId.slice(0, -ART_BLOCKS_TOKEN_ID_LENGTH)}`
      }
      return address
    },
  },
)
export const fetchCollectionSlug = async (address: string, tokenId: string) => {
  return collectionSlugLoader.load({ address, tokenId }) as Promise<string>
}

const tokenPropertiesQuery = gql`
  query TokenPropertiesQuery($address: String!, $id: StringOrInt!) {
    contract(address: $address) {
      rarityTable
      tokenCount
      traits {
        count
        trait_type
        value
      }
      tokens(input: { stringOrIntIn: [$id] }) {
        score
        rank
        noTraitCountRank
        noTraitCountScore
        attributes {
          trait_type
          value
        }
      }
    }
  }
`
export const fetchTokenProperties = async (
  address: string,
  id: string,
): Promise<{
  token: {
    score: number
    rank: number
    noTraitCountRank: number
    noTraitCountScore: number
    attributes: { trait_type: string; value: string }[]
  }
  tokenCount: number
  rarityTable: {
    scoreMap: Record<string, Record<string, number>>
    missingTraitScores: Record<string, { score: number }>
    implicitExcludes?: string[]
    excludeTraits?: string[]
  }
  traits: { count: number; trait_type: string; value: string }[]
}> => {
  const res = await nonFungibleRequest(tokenPropertiesQuery, {
    address,
    id: id,
  })
  return {
    tokenCount: res.contract.tokenCount,
    token: res.contract.tokens[0],
    rarityTable: res.contract.rarityTable,
    traits: res.contract.traits,
  }
}

export const fetchOptimalGasPreset = async () => {
  return fetch('https://nonfungible.tools/api/gas').then((res) => res.json())
}

const nodeProviderKeyQuery = gql`
  query NodeProviderKey {
    nodeProviderKey
  }
`

const nodeProviderKeyLoader = new DataLoader(
  async () => {
    const res = await nonFungibleRequest(
      nodeProviderKeyQuery,
      {},
      false,
      GRAPHQL_AUTH_URL,
    )
    return [res.nodeProviderKey]
  },
  {
    maxBatchSize: 1,
  },
)

export const fetchAlchemyKey = async (): Promise<string> => {
  return nodeProviderKeyLoader.load('key')
}

export const fetchMetadata = async (
  contractAddress: string,
  tokenId: number,
) => {
  return fetch(
    `https://nonfungible.tools/api/metadata-proxy?address=${contractAddress}&tokenId=${tokenId}`,
  ).then((res) => res.json())
}

export const fetchOpenSeaGraphQL = async <
  T extends keyof RemoteConfigs['opensea']['queries']
>(
  query: T,
  {
    variables,
    sessionKey,
    cacheBust = true,
  }: {
    variables: Record<
      keyof RemoteConfigs['opensea']['queries'][T]['dynamicVariablePaths'],
      any
    >
    sessionKey?: string
    cacheBust?: boolean
  },
) => {
  const remoteConfig = await fetchRemoteConfig()
  return fetch('https://api.opensea.io/graphql/', {
    method: 'POST',
    headers: {
      ..._.omit(remoteConfig.queryHeaders, 'x-api-key'),
      ...remoteConfig.queries[query].staticHeaders,
      ...(sessionKey ? { authorization: `JWT ${sessionKey}` } : {}),
    },
    body: JSON.stringify({
      id: query,
      query: remoteConfig.queries[query].body,
      variables: {
        ...remoteConfig.queries[query].staticVariables,
        ...Object.keys(remoteConfig.queries[query].dynamicVariablePaths).reduce(
          (acc: any, key: any) => {
            acc[
              (remoteConfig.queries[query].dynamicVariablePaths as any)[key]
            ] = (variables as any)[key]
            return acc
          },
          {},
        ),
        ...(cacheBust ? { cacheBust: Math.random() } : {}),
      },
    }),
    credentials: 'omit',
  }).then((res) => res.json())
}
