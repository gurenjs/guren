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

/** Paginator for offset-based pagination. */
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

  items(): T[] {
    return this._items
  }

  total(): number {
    return this._total
  }

  perPage(): number {
    return this._perPage
  }

  currentPage(): number {
    return this._currentPage
  }

  lastPage(): number {
    return Math.max(1, Math.ceil(this._total / this._perPage))
  }

  hasMorePages(): boolean {
    return this._currentPage < this.lastPage()
  }

  onFirstPage(): boolean {
    return this._currentPage <= 1
  }

  onLastPage(): boolean {
    return this._currentPage >= this.lastPage()
  }

  /** The 1-based index of the first item on this page. */
  firstItem(): number | null {
    if (this._items.length === 0) return null
    return (this._currentPage - 1) * this._perPage + 1
  }

  /** The 1-based index of the last item on this page. */
  lastItem(): number | null {
    if (this._items.length === 0) return null
    return this.firstItem()! + this._items.length - 1
  }

  count(): number {
    return this._items.length
  }

  isEmpty(): boolean {
    return this._items.length === 0
  }

  isNotEmpty(): boolean {
    return this._items.length > 0
  }

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

  /** Every URL is null until a base path is set with {@link withPath}. */
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

  withPath(path: string): this {
    this._options.path = path
    return this
  }

  withQuery(query: Record<string, string>): this {
    this._options.query = { ...this._options.query, ...query }
    return this
  }

  fragment(fragment: string): this {
    this._options.fragment = fragment
    return this
  }

  toResource<R extends Resource<T>>(
    resourceClass: ResourceClass<T, R>
  ): PaginatedResponse<ResourceData> {
    return {
      data: this._items.map((item) => new resourceClass(item).toJSON()),
      meta: this.meta(),
      links: this.links(),
    }
  }

  toJSON(): PaginatedResponse<T> {
    return {
      data: this._items,
      meta: this.meta(),
      links: this.links(),
    }
  }

  map<U>(callback: (item: T, index: number) => U): Paginator<U> {
    return new Paginator(
      this._items.map(callback),
      this._total,
      this._perPage,
      this._currentPage,
      this._options
    )
  }

  toArray(): T[] {
    return this._items
  }

  *[Symbol.iterator](): Iterator<T> {
    yield* this._items
  }

  /** Slices `items` itself; `total` is the full array length. */
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

  /** Create a paginator from an ORM-style paginated result. */
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

/** Create a paginator. */
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
