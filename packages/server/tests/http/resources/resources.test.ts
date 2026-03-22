import { describe, it, expect } from 'vitest'
import {
  Resource,
  JsonResource,
  collect,
  ResourceCollection,
  Paginator,
  paginate,
  CursorPaginator,
  cursorPaginate,
  encodeCursor,
  decodeCursor,
} from '../../../src/http/resources'

// Test types
interface User {
  id: number
  name: string
  email: string
  role?: string
  posts?: Post[]
  createdAt: Date
}

interface Post {
  id: number
  title: string
  content: string
}

// Test resource classes
class UserResource extends Resource<User> {
  toArray() {
    return {
      id: this.resource.id,
      name: this.resource.name,
      email: this.resource.email,
      role: this.when(this.resource.role !== undefined, this.resource.role),
      posts: this.whenLoaded('posts', () =>
        PostResource.collection(this.resource.posts!)
      ),
      createdAt: this.resource.createdAt.toISOString(),
    }
  }
}

class PostResource extends Resource<Post> {
  toArray() {
    return {
      id: this.resource.id,
      title: this.resource.title,
      content: this.resource.content,
    }
  }
}

describe('Resource', () => {
  const user: User = {
    id: 1,
    name: 'John Doe',
    email: 'john@example.com',
    createdAt: new Date('2024-01-15T10:00:00Z'),
  }

  describe('toArray', () => {
    it('transforms resource to array', () => {
      const resource = new UserResource(user)
      const result = resource.toArray()

      expect(result.id).toBe(1)
      expect(result.name).toBe('John Doe')
      expect(result.email).toBe('john@example.com')
    })
  })

  describe('toJSON', () => {
    it('transforms resource to JSON', () => {
      const resource = new UserResource(user)
      const result = resource.toJSON()

      expect(result.id).toBe(1)
      expect(result.name).toBe('John Doe')
    })

    it('includes additional data', () => {
      const resource = new UserResource(user)
      resource.additional({ extra: 'value' })
      const result = resource.toJSON()

      expect(result.extra).toBe('value')
    })
  })

  describe('when', () => {
    it('includes value when condition is true', () => {
      const userWithRole: User = { ...user, role: 'admin' }
      const resource = new UserResource(userWithRole)
      const result = resource.toArray()

      expect(result.role).toBe('admin')
    })

    it('excludes value when condition is false', () => {
      const resource = new UserResource(user)
      const result = resource.toArray()

      expect(result.role).toBeUndefined()
    })

    it('evaluates function when condition is true', () => {
      class TestResource extends Resource<User> {
        toArray() {
          return {
            computed: this.when(true, () => 'computed-value'),
          }
        }
      }

      const resource = new TestResource(user)
      expect(resource.toArray().computed).toBe('computed-value')
    })
  })

  describe('whenLoaded', () => {
    it('includes relation when loaded', () => {
      const userWithPosts: User = {
        ...user,
        posts: [{ id: 1, title: 'Post 1', content: 'Content 1' }],
      }
      const resource = new UserResource(userWithPosts)
      const result = resource.toArray()

      expect(result.posts).toHaveLength(1)
      expect((result.posts as any)[0].title).toBe('Post 1')
    })

    it('excludes relation when not loaded', () => {
      const resource = new UserResource(user)
      const result = resource.toArray()

      expect(result.posts).toBeUndefined()
    })

    it('returns default value when not loaded', () => {
      class TestResource extends Resource<User> {
        toArray() {
          return {
            posts: this.whenLoaded('posts', () => [], []),
          }
        }
      }

      const resource = new TestResource(user)
      expect(resource.toArray().posts).toEqual([])
    })
  })

  describe('static methods', () => {
    it('make creates new instance', () => {
      const resource = UserResource.make(user)
      expect(resource).toBeInstanceOf(UserResource)
      expect(resource.toJSON().id).toBe(1)
    })

    it('collection transforms array', () => {
      const users = [
        { ...user, id: 1 },
        { ...user, id: 2 },
      ]
      const result = UserResource.collection(users)

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe(1)
      expect(result[1].id).toBe(2)
    })
  })

  describe('collect helper', () => {
    it('transforms array to resource collection', () => {
      const users = [
        { ...user, id: 1 },
        { ...user, id: 2 },
      ]
      const result = collect(users, UserResource)

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe(1)
    })
  })
})

describe('JsonResource', () => {
  it('passes through object properties', () => {
    const data = { id: 1, name: 'Test' }
    const resource = new JsonResource(data)
    const result = resource.toJSON()

    expect(result).toEqual({ id: 1, name: 'Test' })
  })
})

describe('ResourceCollection', () => {
  const users: User[] = [
    { id: 1, name: 'John', email: 'john@example.com', createdAt: new Date() },
    { id: 2, name: 'Jane', email: 'jane@example.com', createdAt: new Date() },
  ]

  describe('toArray', () => {
    it('transforms all resources', () => {
      const collection = new ResourceCollection(users, UserResource)
      const result = collection.toArray()

      expect(result).toHaveLength(2)
      expect(result[0].name).toBe('John')
      expect(result[1].name).toBe('Jane')
    })
  })

  describe('toJSON', () => {
    it('wraps in data key by default', () => {
      const collection = new ResourceCollection(users, UserResource)
      const result = collection.toJSON()

      expect(result.data).toHaveLength(2)
    })

    it('supports custom wrap key', () => {
      const collection = new ResourceCollection(users, UserResource)
      collection.wrap('users')
      const result = collection.toJSON()

      expect(result.users).toHaveLength(2)
    })

    it('supports no wrapping', () => {
      const collection = new ResourceCollection(users, UserResource)
      collection.withoutWrapping()
      const result = collection.toJSON()

      expect(Array.isArray(result)).toBe(true)
    })

    it('includes additional data', () => {
      const collection = new ResourceCollection(users, UserResource)
      collection.additional({ total: 100 })
      const result = collection.toJSON()

      expect(result.total).toBe(100)
    })
  })

  describe('utility methods', () => {
    it('count returns number of items', () => {
      const collection = new ResourceCollection(users, UserResource)
      expect(collection.count()).toBe(2)
    })

    it('isEmpty returns true for empty collection', () => {
      const collection = new ResourceCollection([], UserResource)
      expect(collection.isEmpty()).toBe(true)
      expect(collection.isNotEmpty()).toBe(false)
    })

    it('filter returns filtered collection', () => {
      const collection = new ResourceCollection(users, UserResource)
      const filtered = collection.filter((u) => u.id === 1)

      expect(filtered.count()).toBe(1)
      expect(filtered.toArray()[0].name).toBe('John')
    })

    it('all returns underlying array', () => {
      const collection = new ResourceCollection(users, UserResource)
      expect(collection.all()).toBe(users)
    })
  })
})

describe('Paginator', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    name: `Item ${i + 1}`,
  }))

  describe('basic pagination', () => {
    it('returns correct page of items', () => {
      const paginator = new Paginator(
        items.slice(0, 10),
        100,
        10,
        1
      )

      expect(paginator.items()).toHaveLength(10)
      expect(paginator.total()).toBe(100)
      expect(paginator.perPage()).toBe(10)
      expect(paginator.currentPage()).toBe(1)
    })

    it('calculates last page correctly', () => {
      const paginator = new Paginator(items.slice(0, 10), 100, 10, 1)
      expect(paginator.lastPage()).toBe(10)
    })

    it('calculates last page for uneven total', () => {
      const paginator = new Paginator(items.slice(0, 10), 95, 10, 1)
      expect(paginator.lastPage()).toBe(10)
    })

    it('handles empty result', () => {
      const paginator = new Paginator([], 0, 10, 1)

      expect(paginator.isEmpty()).toBe(true)
      expect(paginator.firstItem()).toBeNull()
      expect(paginator.lastItem()).toBeNull()
    })
  })

  describe('navigation', () => {
    it('hasMorePages returns true when not on last page', () => {
      const paginator = new Paginator(items.slice(0, 10), 100, 10, 1)
      expect(paginator.hasMorePages()).toBe(true)
    })

    it('hasMorePages returns false on last page', () => {
      const paginator = new Paginator(items.slice(90, 100), 100, 10, 10)
      expect(paginator.hasMorePages()).toBe(false)
    })

    it('onFirstPage returns true on page 1', () => {
      const paginator = new Paginator(items.slice(0, 10), 100, 10, 1)
      expect(paginator.onFirstPage()).toBe(true)
    })

    it('onLastPage returns true on final page', () => {
      const paginator = new Paginator(items.slice(90, 100), 100, 10, 10)
      expect(paginator.onLastPage()).toBe(true)
    })
  })

  describe('meta', () => {
    it('returns correct meta information', () => {
      const paginator = new Paginator(items.slice(10, 20), 100, 10, 2)
      const meta = paginator.meta()

      expect(meta.currentPage).toBe(2)
      expect(meta.lastPage).toBe(10)
      expect(meta.perPage).toBe(10)
      expect(meta.total).toBe(100)
      expect(meta.from).toBe(11)
      expect(meta.to).toBe(20)
    })
  })

  describe('links', () => {
    it('generates links with path', () => {
      const paginator = new Paginator(items.slice(10, 20), 100, 10, 2)
      paginator.withPath('/api/items')
      const links = paginator.links()

      expect(links.first).toBe('/api/items?page=1')
      expect(links.last).toBe('/api/items?page=10')
      expect(links.prev).toBe('/api/items?page=1')
      expect(links.next).toBe('/api/items?page=3')
      expect(links.pages[1]).toEqual({
        page: 2,
        url: '/api/items?page=2',
        active: true,
      })
    })

    it('returns null links without path', () => {
      const paginator = new Paginator(items.slice(0, 10), 100, 10, 1)
      const links = paginator.links()

      expect(links.first).toBeNull()
      expect(links.prev).toBeNull()
      expect(links.pages[0]).toEqual({
        page: 1,
        url: null,
        active: true,
      })
    })

    it('prev is null on first page', () => {
      const paginator = new Paginator(items.slice(0, 10), 100, 10, 1)
      paginator.withPath('/api/items')
      const links = paginator.links()

      expect(links.prev).toBeNull()
    })

    it('next is null on last page', () => {
      const paginator = new Paginator(items.slice(90, 100), 100, 10, 10)
      paginator.withPath('/api/items')
      const links = paginator.links()

      expect(links.next).toBeNull()
    })
  })

  describe('toResource', () => {
    it('transforms items to resources', () => {
      interface Item {
        id: number
        name: string
      }

      class ItemResource extends Resource<Item> {
        toArray() {
          return {
            id: this.resource.id,
            name: this.resource.name.toUpperCase(),
          }
        }
      }

      const paginator = new Paginator(items.slice(0, 2), 100, 10, 1)
      const result = paginator.toResource(ItemResource)

      expect(result.data).toHaveLength(2)
      expect(result.data[0].name).toBe('ITEM 1')
      expect(result.meta.total).toBe(100)
    })
  })

  describe('toJSON', () => {
    it('returns paginated response', () => {
      const paginator = new Paginator(items.slice(0, 10), 100, 10, 1)
      const json = paginator.toJSON()

      expect(json.data).toHaveLength(10)
      expect(json.meta.total).toBe(100)
      expect(json.links).toBeDefined()
    })
  })

  describe('fromArray', () => {
    it('creates paginator from full array', () => {
      const paginator = Paginator.fromArray(items, 2, 10)

      expect(paginator.items()).toHaveLength(10)
      expect(paginator.items()[0].id).toBe(11)
      expect(paginator.total()).toBe(100)
    })
  })

  describe('iteration', () => {
    it('supports for...of', () => {
      const paginator = new Paginator(items.slice(0, 3), 100, 10, 1)
      const result: typeof items = []

      for (const item of paginator) {
        result.push(item)
      }

      expect(result).toHaveLength(3)
    })
  })
})

describe('CursorPaginator', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    name: `Item ${i + 1}`,
  }))

  describe('basic cursor pagination', () => {
    it('returns items with cursor info', () => {
      const paginator = new CursorPaginator(
        items.slice(0, 10),
        10,
        true,
        { nextCursor: '10' }
      )

      expect(paginator.items()).toHaveLength(10)
      expect(paginator.perPage()).toBe(10)
      expect(paginator.hasMorePages()).toBe(true)
      expect(paginator.nextCursor()).toBe('10')
    })

    it('handles last page', () => {
      const paginator = new CursorPaginator(
        items.slice(40, 50),
        10,
        false
      )

      expect(paginator.hasMorePages()).toBe(false)
      expect(paginator.nextCursor()).toBeNull()
    })
  })

  describe('meta', () => {
    it('returns cursor meta information', () => {
      const paginator = new CursorPaginator(
        items.slice(0, 10),
        10,
        true,
        { nextCursor: '10', prevCursor: null }
      )
      const meta = paginator.meta()

      expect(meta.perPage).toBe(10)
      expect(meta.nextCursor).toBe('10')
      expect(meta.prevCursor).toBeNull()
      expect(meta.hasMore).toBe(true)
    })
  })

  describe('toJSON', () => {
    it('returns cursor paginated response', () => {
      const paginator = new CursorPaginator(
        items.slice(0, 10),
        10,
        true,
        { nextCursor: '10' }
      )
      const json = paginator.toJSON()

      expect(json.data).toHaveLength(10)
      expect(json.meta.hasMore).toBe(true)
    })
  })

  describe('fromArray', () => {
    it('creates cursor paginator from array', () => {
      const paginator = CursorPaginator.fromArray(items, null, 10)

      expect(paginator.items()).toHaveLength(10)
      expect(paginator.items()[0].id).toBe(1)
      expect(paginator.hasMorePages()).toBe(true)
      expect(paginator.nextCursor()).toBe('10')
    })

    it('paginates from cursor position', () => {
      const paginator = CursorPaginator.fromArray(items, '10', 10)

      expect(paginator.items()).toHaveLength(10)
      expect(paginator.items()[0].id).toBe(11)
      expect(paginator.prevCursor()).toBe('10')
    })

    it('handles last page correctly', () => {
      const paginator = CursorPaginator.fromArray(items, '45', 10)

      expect(paginator.items()).toHaveLength(5)
      expect(paginator.hasMorePages()).toBe(false)
    })
  })
})

describe('cursor encoding', () => {
  describe('encodeCursor', () => {
    it('encodes string value', () => {
      const encoded = encodeCursor('123')
      expect(encoded).toBeTruthy()
      expect(encoded).not.toBe('123')
    })

    it('encodes number value', () => {
      const encoded = encodeCursor(123)
      expect(encoded).toBeTruthy()
    })

    it('encodes date value', () => {
      const date = new Date('2024-01-15T10:00:00Z')
      const encoded = encodeCursor(date)
      expect(encoded).toBeTruthy()
    })
  })

  describe('decodeCursor', () => {
    it('decodes encoded cursor', () => {
      const encoded = encodeCursor('123')
      const decoded = decodeCursor(encoded)
      expect(decoded).toBe('123')
    })

    it('handles invalid cursor gracefully', () => {
      const decoded = decodeCursor('not-base64!!!')
      expect(decoded).toBeTruthy()
    })
  })
})

describe('paginate helper', () => {
  it('creates paginator', () => {
    const items = [1, 2, 3]
    const paginator = paginate(items, 100, 10, 1)

    expect(paginator).toBeInstanceOf(Paginator)
    expect(paginator.items()).toEqual([1, 2, 3])
  })

  it('creates paginator from a paginated result', () => {
    const paginator = paginate({
      data: [1, 2, 3],
      meta: {
        total: 23,
        perPage: 10,
        currentPage: 3,
      },
    }, {
      path: '/api/items',
      query: { per_page: '10' },
    })

    expect(paginator).toBeInstanceOf(Paginator)
    expect(paginator.currentPage()).toBe(3)
    expect(paginator.perPage()).toBe(10)
    expect(paginator.links().prev).toBe('/api/items?per_page=10&page=2')
    expect(paginator.links().next).toBeNull()
  })
})

describe('cursorPaginate helper', () => {
  it('creates cursor paginator', () => {
    const items = [1, 2, 3]
    const paginator = cursorPaginate(items, 10, true, { nextCursor: '3' })

    expect(paginator).toBeInstanceOf(CursorPaginator)
    expect(paginator.items()).toEqual([1, 2, 3])
  })
})
