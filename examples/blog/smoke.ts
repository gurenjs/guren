import app, { ready } from './src/main.ts'

async function main() {
  try {
    await ready
  } catch (error) {
    console.warn('Skipping smoke test: database is not reachable.', error)
    return
  }

  const root = await app.fetch(new Request('http://example.local/'))
  if (root.status !== 200) {
    throw new Error(`Unexpected status for /: ${root.status}`)
  }

  const rootHtml = await root.text()
  if (!rootHtml.includes('Latest Posts')) {
    throw new Error('SSR markup missing expected content for posts index')
  }

  const posts = await app.fetch(
    new Request('http://example.local/posts', {
      headers: {
        'X-Inertia': 'true',
        Accept: 'application/json',
      },
    }),
  )
  if (posts.status !== 200) {
    throw new Error(`Unexpected status for /posts: ${posts.status}`)
  }

  const payload = await posts.json()
  if (payload.component !== 'posts/Index') {
    throw new Error('Inertia component mismatch for posts index')
  }

  console.log('Smoke test passed: SSR HTML and JSON endpoints responded successfully')
}

await main()
