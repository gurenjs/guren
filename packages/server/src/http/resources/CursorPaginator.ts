import type {
  CursorPaginationMeta,
  CursorPaginatedResponse,
  CursorPaginatorOptions,
  ResourceData,
  ResourceClass,
} from './types'
import type { Resource } from './Resource'

/**
 * Cursor paginator for cursor-based pagination.
 * Ideal for infinite scroll and real-time data.
 */
export class CursorPaginator<T> {
  protected _items: T[]
  protected _perPage: number
  protected _currentCursor: string | null
  protected _nextCursor: string | null
  protected _prevCursor: string | null
  protected _hasMore: boolean
  protected _options: CursorPaginatorOptions

  constructor(
    items: T[],
    perPage: number,
    hasMore: boolean,
    options: CursorPaginatorOptions & {
      currentCursor?: string | null
      nextCursor?: string | null
      prevCursor?: string | null
    } = {}
  ) {
    this._items = items
    this._perPage = Math.max(1, perPage)
    this._hasMore = hasMore
    this._currentCursor = options.currentCursor ?? null
    this._nextCursor = options.nextCursor ?? null
    this._prevCursor = options.prevCursor ?? null
    this._options = options
  }

  /**
   * Get the paginated items.
   */
  items(): T[] {
    return this._items
  }

  /**
   * Get items per page.
   */
  perPage(): number {
    return this._perPage
  }

  /**
   * Get the current cursor.
   */
  currentCursor(): string | null {
    return this._currentCursor
  }

  /**
   * Get the next cursor.
   */
  nextCursor(): string | null {
    return this._nextCursor
  }

  /**
   * Get the previous cursor.
   */
  prevCursor(): string | null {
    return this._prevCursor
  }

  /**
   * Check if there are more items.
   */
  hasMorePages(): boolean {
    return this._hasMore
  }

  /**
   * Check if there are previous items.
   */
  hasPreviousPages(): boolean {
    return this._prevCursor !== null
  }

  /**
   * Get the number of items.
   */
  count(): number {
    return this._items.length
  }

  /**
   * Check if empty.
   */
  isEmpty(): boolean {
    return this._items.length === 0
  }

  /**
   * Check if not empty.
   */
  isNotEmpty(): boolean {
    return this._items.length > 0
  }

  /**
   * Get cursor pagination meta.
   */
  meta(): CursorPaginationMeta {
    return {
      perPage: this._perPage,
      nextCursor: this._nextCursor,
      prevCursor: this._prevCursor,
      hasMore: this._hasMore,
    }
  }

  /**
   * Transform items to resources.
   */
  toResource<R extends Resource<T>>(
    resourceClass: ResourceClass<T, R>
  ): CursorPaginatedResponse<ResourceData> {
    return {
      data: this._items.map((item) => new resourceClass(item).toJSON()),
      meta: this.meta(),
    }
  }

  /**
   * Transform to JSON.
   */
  toJSON(): CursorPaginatedResponse<T> {
    return {
      data: this._items,
      meta: this.meta(),
    }
  }

  /**
   * Map over items.
   */
  map<U>(callback: (item: T, index: number) => U): CursorPaginator<U> {
    return new CursorPaginator(
      this._items.map(callback),
      this._perPage,
      this._hasMore,
      {
        ...this._options,
        currentCursor: this._currentCursor,
        nextCursor: this._nextCursor,
        prevCursor: this._prevCursor,
      }
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
   * Create cursor paginator from array with ID-based cursor.
   */
  static fromArray<T extends { id: string | number }>(
    items: T[],
    cursor: string | null,
    perPage: number,
    options?: CursorPaginatorOptions
  ): CursorPaginator<T> {
    let filteredItems = items
    let prevCursor: string | null = null

    if (cursor) {
      const cursorIndex = items.findIndex(
        (item) => String(item.id) === cursor
      )
      if (cursorIndex !== -1) {
        filteredItems = items.slice(cursorIndex + 1)
        prevCursor = cursor
      }
    }

    const pageItems = filteredItems.slice(0, perPage)
    const hasMore = filteredItems.length > perPage

    const nextCursor =
      hasMore && pageItems.length > 0
        ? String(pageItems[pageItems.length - 1].id)
        : null

    return new CursorPaginator(pageItems, perPage, hasMore, {
      ...options,
      currentCursor: cursor,
      nextCursor,
      prevCursor,
    })
  }
}

/**
 * Encode a cursor value.
 */
export function encodeCursor(value: string | number | Date): string {
  const strValue = value instanceof Date ? value.toISOString() : String(value)
  return Buffer.from(strValue).toString('base64url')
}

/**
 * Decode a cursor value.
 */
export function decodeCursor(cursor: string): string {
  try {
    return Buffer.from(cursor, 'base64url').toString('utf-8')
  } catch {
    return cursor
  }
}

/**
 * Create a cursor paginator.
 */
export function cursorPaginate<T>(
  items: T[],
  perPage: number,
  hasMore: boolean,
  options?: CursorPaginatorOptions & {
    currentCursor?: string | null
    nextCursor?: string | null
    prevCursor?: string | null
  }
): CursorPaginator<T> {
  return new CursorPaginator(items, perPage, hasMore, options)
}
