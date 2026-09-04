import type {
  CursorPaginationMeta,
  CursorPaginatedResponse,
  CursorPaginatorOptions,
  ResourceData,
  ResourceClass,
} from './types'
import type { Resource } from './Resource'

/** Cursor-based pagination, for infinite scroll and real-time data. */
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

  items(): T[] {
    return this._items
  }

  perPage(): number {
    return this._perPage
  }

  currentCursor(): string | null {
    return this._currentCursor
  }

  nextCursor(): string | null {
    return this._nextCursor
  }

  prevCursor(): string | null {
    return this._prevCursor
  }

  hasMorePages(): boolean {
    return this._hasMore
  }

  hasPreviousPages(): boolean {
    return this._prevCursor !== null
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

  meta(): CursorPaginationMeta {
    return {
      perPage: this._perPage,
      nextCursor: this._nextCursor,
      prevCursor: this._prevCursor,
      hasMore: this._hasMore,
    }
  }

  toResource<R extends Resource<T>>(
    resourceClass: ResourceClass<T, R>
  ): CursorPaginatedResponse<ResourceData> {
    return {
      data: this._items.map((item) => new resourceClass(item).toJSON()),
      meta: this.meta(),
    }
  }

  toJSON(): CursorPaginatedResponse<T> {
    return {
      data: this._items,
      meta: this.meta(),
    }
  }

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

  toArray(): T[] {
    return this._items
  }

  *[Symbol.iterator](): Iterator<T> {
    yield* this._items
  }

  /** The cursor is the id of the last item on the previous page. */
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

/** Encode a cursor value. */
export function encodeCursor(value: string | number | Date): string {
  const strValue = value instanceof Date ? value.toISOString() : String(value)
  return Buffer.from(strValue).toString('base64url')
}

/** Returns the cursor unchanged when it is not valid base64url. */
export function decodeCursor(cursor: string): string {
  try {
    return Buffer.from(cursor, 'base64url').toString('utf-8')
  } catch {
    return cursor
  }
}

/** Create a cursor paginator. */
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
