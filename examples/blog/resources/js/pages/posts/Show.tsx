import { Link } from '@inertiajs/react'
import type { PostShowPageProps } from '@/Http/Controllers/PostController'
import Layout from '../../components/Layout.js'
import { ArrowLeft, Calendar, User } from 'lucide-react'

export default function Show({ post }: PostShowPageProps) {
  return (
    <Layout
      wrapperClassName="bg-zinc-50"
      mainClassName="max-w-3xl mx-auto px-6 py-12"
    >
      <article className="bg-white p-8 shadow-sm ring-1 ring-zinc-200 sm:rounded-2xl sm:p-12">
        <Link
          href="/posts"
          className="group mb-8 inline-flex items-center text-sm font-medium text-zinc-500 transition hover:text-zinc-900"
        >
          <ArrowLeft className="mr-2 h-4 w-4 transition-transform group-hover:-translate-x-1" />
          Back to posts
        </Link>

        <header className="mb-10">
          <div className="mb-6 flex items-center gap-4 text-sm text-zinc-500">
            <span className="flex items-center gap-1.5">
              <Calendar className="h-4 w-4" />
              {new Date().toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric'
              })}
            </span>
            <span className="h-1 w-1 rounded-full bg-zinc-300" />
            <span className="flex items-center gap-1.5">
              <User className="h-4 w-4" />
              {post.author?.name ?? 'Unknown author'}
            </span>
          </div>

          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl lg:text-5xl">
            {post.title}
          </h1>
        </header>

        <div className="prose prose-zinc prose-lg max-w-none">
          <p className="lead text-xl text-zinc-600">{post.excerpt}</p>
          <div className="mt-8 space-y-6 text-zinc-700">
            {(post.body || '').split('\n').map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        </div>

        <hr className="my-12 border-zinc-100" />

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-guren-50 text-guren-600 ring-1 ring-guren-100">
              <span className="text-lg font-bold">
                {(post.author?.name ?? post.title).charAt(0).toUpperCase()}
              </span>
            </div>
            <div>
              <p className="font-medium text-zinc-900">{post.author?.name ?? 'Unknown author'}</p>
              <p className="text-sm text-zinc-500">Author</p>
            </div>
          </div>
        </div>
      </article>
    </Layout>
  )
}
