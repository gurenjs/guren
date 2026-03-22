/**
 * Resource data type.
 */
export type ResourceData = Record<string, unknown>

export type ValidationErrors<TField extends string = string> = Partial<Record<TField | 'message', string>>

/**
 * Pagination meta information.
 */
export interface PaginationMeta {
  currentPage: number
  lastPage: number
  perPage: number
  total: number
  from: number | null
  to: number | null
}

/**
 * Pagination links.
 */
export interface PaginationPageLink {
  page: number
  url: string | null
  active: boolean
}

export interface PaginationLinks {
  first: string | null
  last: string | null
  prev: string | null
  next: string | null
  pages: PaginationPageLink[]
}

/**
 * Paginated response structure.
 */
export interface PaginatedResponse<T> {
  data: T[]
  meta: PaginationMeta
  links: PaginationLinks
}

export interface PaginatedPageProps<T> extends Record<string, unknown> {
  data: T[]
  pagination: {
    meta: PaginationMeta
    links: PaginationLinks
  }
}

/**
 * Cursor pagination meta information.
 */
export interface CursorPaginationMeta {
  perPage: number
  nextCursor: string | null
  prevCursor: string | null
  hasMore: boolean
}

/**
 * Cursor paginated response structure.
 */
export interface CursorPaginatedResponse<T> {
  data: T[]
  meta: CursorPaginationMeta
}

/**
 * Paginator options.
 */
export interface PaginatorOptions {
  path?: string
  query?: Record<string, string>
  fragment?: string
}

/**
 * Cursor paginator options.
 */
export interface CursorPaginatorOptions {
  cursorName?: string
  parameters?: Record<string, string>
}

/**
 * Resource class type.
 */
export interface ResourceClass<T, R extends BaseResource<T>> {
  new (resource: T): R
}

/**
 * Base resource interface.
 */
export interface BaseResource<T> {
  toArray(): ResourceData
  toJSON(): ResourceData
}

export type InferResourceData<TResource extends BaseResource<unknown>> = ReturnType<TResource['toJSON']>
