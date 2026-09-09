/**
 * The blog's prototype fixture (RFC 0021): under `vite --mode prototype` this
 * answers every Inertia visit in the browser, so `dist/prototype/` runs on any
 * static host with no server. The pages and their Props are the production
 * ones; only who fills the props differs.
 */
import { apiRoutes, definePrototype, page } from '@guren/inertia-client/prototype'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import { pages } from '@/.guren/pages.gen'
import { routeManifest } from '@/.guren/routes.gen'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'

const demoUser = { id: 1, name: 'Demo Author', email: 'demo@example.com' }

type PostSeed = Pick<PostResourceData, 'id' | 'title' | 'excerpt' | 'body'>

function toResource(post: PostSeed): PostResourceData {
  return {
    ...post,
    cover: null,
    notificationArtifactPath: `notifications/posts/${post.id}.json`,
    broadcastChannels: { public: 'announcements', private: `posts.${post.id}` },
    author: { id: demoUser.id, name: demoUser.name },
  }
}

const PER_PAGE = 10

/** The `PaginatedPageProps` shape an index page expects, over an in-memory list; same helper `guren add prototype` ships. */
function paginate<T>(items: T[], pageNumber: number, path: string) {
  const total = items.length
  const lastPage = Math.max(1, Math.ceil(total / PER_PAGE))
  const currentPage = Math.min(Math.max(1, pageNumber || 1), lastPage)
  const start = (currentPage - 1) * PER_PAGE
  const urlFor = (n: number) => (n === 1 ? path : `${path}?page=${n}`)

  return {
    data: items.slice(start, start + PER_PAGE),
    pagination: {
      meta: {
        currentPage,
        lastPage,
        perPage: PER_PAGE,
        total,
        from: total === 0 ? null : start + 1,
        to: total === 0 ? null : Math.min(start + PER_PAGE, total),
      },
      links: {
        first: urlFor(1),
        last: urlFor(lastPage),
        prev: currentPage > 1 ? urlFor(currentPage - 1) : null,
        next: currentPage < lastPage ? urlFor(currentPage + 1) : null,
        pages: Array.from({ length: lastPage }, (_, index) => ({
          page: index + 1,
          url: urlFor(index + 1),
          active: index + 1 === currentPage,
        })),
      },
    },
  }
}

export default definePrototype({
  manifest: routeManifest,
  api: apiRoutes<ApiRoutes>(),

  // A signed-in author, so the authenticated screens are reachable. The login
  // page still renders, but its native form post has no server to reach.
  shared: {
    auth: { user: demoUser },
    csrfToken: 'prototype',
  },

  state: () => ({
    nextId: 4,
    posts: [
      {
        id: 3,
        title: 'Prototype first, backend second',
        excerpt: 'How a clickable prototype becomes the production frontend without a rewrite.',
        body: 'Every page in this prototype is the real page component. When the backend arrives, only the data source changes.',
      },
      {
        id: 2,
        title: 'Typed routes end to end',
        excerpt: 'One route manifest, shared by links, forms, and the prototype fixture.',
        body: 'Rename a route and the fixture, the typed links and the controller all fail the same typecheck.',
      },
      {
        id: 1,
        title: 'Hello from the static build',
        excerpt: 'This page was served from a plain file host.',
        body: 'No Bun process, no database. Edit a post and reload: the state lives in this tab.',
      },
    ] as PostSeed[],
  }),

  notFoundPage: pages.Error,

  routes: {
    home: ({ state, query }) => page(pages.posts.Index, paginate(state.posts.map(toResource), Number(query.page ?? 1), '/')),

    'posts.index': ({ state, query }) =>
      page(pages.posts.Index, paginate(state.posts.map(toResource), Number(query.page ?? 1), '/posts')),

    'posts.show': ({ state, params, notFound }) => {
      const post = state.posts.find((p) => p.id === Number(params.id))
      return post ? page(pages.posts.Show, { post: toResource(post) }) : notFound()
    },

    'posts.create': () => page(pages.posts.New, {}),

    'posts.store': ({ state, body, errors, redirect, flash }) => {
      if (!body.title?.trim()) return errors({ title: 'Title is required.' })
      const post: PostSeed = {
        id: state.nextId++,
        title: body.title,
        excerpt: body.excerpt ?? '',
        body: body.body ?? '',
      }
      state.posts.unshift(post)
      flash('success', 'Post created.')
      return redirect('posts.show', { id: post.id })
    },

    'posts.edit': ({ state, params, notFound }) => {
      const post = state.posts.find((p) => p.id === Number(params.id))
      if (!post) return notFound()
      return page(pages.posts.Edit, {
        post: { title: post.title, excerpt: post.excerpt, body: post.body ?? '' },
        postId: post.id,
        cover: null,
      })
    },

    'posts.update': ({ state, params, body, errors, redirect }) => {
      const post = state.posts.find((p) => p.id === Number(params.id))
      if (!post) return errors({ message: 'Post not found.' })
      if (!body.title?.trim()) return errors({ title: 'Title is required.' })
      post.title = body.title
      post.excerpt = body.excerpt ?? ''
      post.body = body.body ?? ''
      return redirect('posts.show', { id: post.id })
    },

    'posts.destroy': ({ state, params, redirect }) => {
      state.posts = state.posts.filter((p) => p.id !== Number(params.id))
      return redirect('posts.index')
    },

    dashboard: () => page(pages.dashboard.Index, { user: demoUser }),

    login: () => page(pages.auth.Login, {}),
    register: () => page(pages.auth.Register, {}),
    logout: ({ redirect }) => redirect('posts.index'),
  },
})
