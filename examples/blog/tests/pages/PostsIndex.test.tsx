import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import PostsIndex from '../../resources/js/pages/posts/Index.js'

const samplePosts = [
  {
    id: 1,
    title: 'Post One',
    excerpt: 'Excerpt',
    body: 'Body',
    cover: null,
    notificationArtifactPath: 'notifications/posts/1.json',
    broadcastChannels: {
      public: 'announcements',
      private: 'posts.1',
    },
    authorId: 1,
    author: { id: 1, name: 'Ada' },
  },
]

describe('Posts index page', () => {
  it('renders link-driven pagination from server links', () => {
    render(<PostsIndex
      data={samplePosts}
      pagination={{
        meta: {
          currentPage: 2,
          lastPage: 3,
          perPage: 6,
          total: 13,
          from: 7,
          to: 12,
        },
        links: {
          first: '/posts?page=1',
          last: '/posts?page=3',
          prev: '/posts?page=1',
          next: '/posts?page=3',
          pages: [
            { page: 1, url: '/posts?page=1', active: false },
            { page: 2, url: '/posts?page=2', active: true },
            { page: 3, url: '/posts?page=3', active: false },
          ],
        },
      }}
    />)

    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute('href', '/posts?page=1')
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute('href', '/posts?page=3')
    expect(screen.getByRole('link', { name: '2' })).toHaveAttribute('href', '/posts?page=2')
  })
})
