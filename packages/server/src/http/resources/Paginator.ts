import type {
  PaginationMeta,
  PaginationLinks,
  PaginatedResponse,
  PaginatorOptions,
  ResourceData,
  ResourceClass,
} from './types'
import type { Resource } from './Resource'

export interface PaginatedResultLike<T> {
  data: T[]
  meta: {
    total: number
    perPage: number
    currentPage: number
  }
}

/**
 * Paginator for offset-based pagination.
 */
export class Paginator<T> {
  protected _items: T[]
  protected _total: number
  protected _perPage: number
  protected _currentPage: number
  protected _options: PaginatorOptions

  constructor(
    items: T[],
    total: number,
    perPage: number,
    currentPage: number,
    options: PaginatorOptions = {}
  ) {
    this._items = items
    this._total = total
    this._perPage = Math.max(1, perPage)
    this._currentPage = Math.max(1, currentPage)
    this._options = options
  }

  /**
   * Get the paginated items.
   */
  items(): T[] {
    return this._items
  }

  /**
   * Get total number of items.
   */
  total(): number {
    return this._total
  }

  /**
   * Get items per page.
   */
  perPage(): number {
    return this._perPage
  }

  /**
   * Get current page number.
   */
  currentPage(): number {
    return this._currentPage
  }

  /**
   * Get last page number.
   */
  lastPage(): number {
    return Math.max(1, Math.ceil(this._total / this._perPage))
  }

  /**
   * Check if there are more pages.
   */
  hasMorePages(): boolean {
    return this._currentPage < this.lastPage()
  }

  /**
   * Check if on first page.
   */
  onFirstPage(): boolean {
    return this._currentPage <= 1
  }

  /**
   * Check if on last page.
   */
  onLastPage(): boolean {
    return this._currentPage >= this.lastPage()
  }

  /**
   * Get the "from" index (1-based).
   */
  firstItem(): number | null {
    if (this._items.length === 0) return null
    return (this._currentPage - 1) * this._perPage + 1
  }

  /**
   * Get the "to" index (1-based).
   */
  lastItem(): number | null {
    if (this._items.length === 0) return null
    return this.firstItem()! + this._items.length - 1
  }

  /**
   * Get the number of items on current page.
   */
  count(): number {
    return this._items.length
  }

  /**
   * Check if the paginator is empty.
   */
  isEmpty(): boolean {
    return this._items.length === 0
  }

  /**
   * Check if the paginator is not empty.
   */
  isNotEmpty(): boolean {
    return this._items.length > 0
  }

  /**
   * Get pagination meta information.
   */
  meta(): PaginationMeta {
    return {
      currentPage: this._currentPage,
      lastPage: this.lastPage(),
      perPage: this._perPage,
      total: this._total,
      from: this.firstItem(),
      to: this.lastItem(),
    }
  }

  /**
   * Build URL for a page.
   */
  protected url(page: number): string {
    const path = this._options.path ?? ''
    const query = new URLSearchParams(this._options.query ?? {})
    query.set('page', String(page))

    let url = path
    const queryString = query.toString()
    if (queryString) {
      url += (path.includes('?') ? '&' : '?') + queryString
    }
    if (this._options.fragment) {
      url += '#' + this._options.fragment
    }

    return url
  }

  /**
   * Get pagination links.
   */
  links(): PaginationLinks {
    const path = this._options.path
    const pages = Array.from({ length: this.lastPage() }, (_, index) => {
      const page = index + 1
      return {
        page,
        url: path ? this.url(page) : null,
        active: page === this._currentPage,
      }
    })

    if (!path) {
      return {
        first: null,
        last: null,
        prev: null,
        next: null,
        pages,
      }
    }

    return {
      first: this.url(1),
      last: this.url(this.lastPage()),
      prev: this._currentPage > 1 ? this.url(this._currentPage - 1) : null,
      next: this.hasMorePages() ? this.url(this._currentPage + 1) : null,
      pages,
    }
  }

  /**
   * Set the base path for pagination links.
   */
  withPath(path: string): this {
    this._options.path = path
    return this
  }

  /**
   * Set query parameters for pagination links.
   */
  withQuery(query: Record<string, string>): this {
    this._options.query = { ...this._options.query, ...query }
    return this
  }

  /**
   * Set fragment for pagination links.
   */
  fragment(fragment: string): this {
    this._options.fragment = fragment
    return this
  }

  /**
   * Transform items to resources.
   */
  toResource<R extends Resource<T>>(
    resourceClass: ResourceClass<T, R>
  ): PaginatedResponse<ResourceData> {
    return {
      data: this._items.map((item) => new resourceClass(item).toJSON()),
      meta: this.meta(),
      links: this.links(),
    }
  }

  /**
   * Transform to JSON.
   */
  toJSON(): PaginatedResponse<T> {
    return {
      data: this._items,
      meta: this.meta(),
      links: this.links(),
    }
  }

  /**
   * Map over items.
   */
  map<U>(callback: (item: T, index: number) => U): Paginator<U> {
    return new Paginator(
      this._items.map(callback),
      this._total,
      this._perPage,
      this._currentPage,
      this._options
    )
  }

  /**
   * Get items as array.
   */
  toArray(): T[] {
    return this._items
  }

  /**
   * Iterate over items.
   */
  *[Symbol.iterator](): Iterator<T> {
    yield* this._items
  }

  /**
   * Create paginator from array (slices the array).
   */
  static fromArray<T>(
    items: T[],
    page: number,
    perPage: number,
    options?: PaginatorOptions
  ): Paginator<T> {
    const total = items.length
    const offset = (page - 1) * perPage
    const pageItems = items.slice(offset, offset + perPage)

    return new Paginator(pageItems, total, perPage, page, options)
  }

  /**
   * Create paginator from an ORM-style paginated result.
   */
  static fromPaginatedResult<T>(
    result: PaginatedResultLike<T>,
    options?: PaginatorOptions
  ): Paginator<T> {
    return new Paginator(
      result.data,
      result.meta.total,
      result.meta.perPage,
      result.meta.currentPage,
      options
    )
  }
}

/**
 * Create a paginator.
 */
export function paginate<T>(
  result: PaginatedResultLike<T>,
  options?: PaginatorOptions
): Paginator<T>
export function paginate<T>(
  items: T[],
  total: number,
  perPage: number,
  currentPage: number,
  options?: PaginatorOptions
): Paginator<T>
export function paginate<T>(
  itemsOrResult: T[] | PaginatedResultLike<T>,
  totalOrOptions?: number | PaginatorOptions,
  perPage?: number,
  currentPage?: number,
  options?: PaginatorOptions
): Paginator<T> {
  if (!Array.isArray(itemsOrResult)) {
    return Paginator.fromPaginatedResult(itemsOrResult, totalOrOptions as PaginatorOptions | undefined)
  }

  return new Paginator(itemsOrResult, totalOrOptions as number, perPage as number, currentPage as number, options)
}
