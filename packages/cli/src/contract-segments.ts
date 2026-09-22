/** The `RouteContractOptions` keys whose value is a schema, in the order a request reads them. */
export const CONTRACT_SEGMENTS = ['params', 'query', 'body'] as const

export type ContractSegment = (typeof CONTRACT_SEGMENTS)[number]
