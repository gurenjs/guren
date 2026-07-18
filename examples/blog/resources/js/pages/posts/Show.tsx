import { Link } from '@inertiajs/react'
import Layout from '../../components/Layout.js'
import { ArrowLeft } from 'lucide-react'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

interface Props {
  post: PostResourceData
}

export default function Show({ post }: Props) {
  return (
    <Layout
      mainClassName="max-w-3xl mx-auto px-6 pt-10 pb-16 sm:pt-12 sm:pb-24"
    >
      <article>
        <Link
          href={route('posts.index')}
          className="group inline-flex items-center text-sm text-stone-400 transition-colors hover:text-stone-600"
        >
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" />
          Back to posts
        </Link>

        <header className="mt-10">
          <div className="flex items-center gap-3 text-xs font-normal uppercase tracking-widest text-stone-400">
            <time>
              {new Date().toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric'
              })}
            </time>
            <span className="text-stone-300">/</span>
            <span>{post.author?.name ?? 'Unknown author'}</span>
          </div>

          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl lg:text-5xl">
            {post.title}
          </h1>

          <div className="mt-6 h-0.5 w-12 bg-guren-600" />
        </header>

        <div className="mt-10">
          <p className="text-xl leading-relaxed text-stone-500">{post.excerpt}</p>

          <div className="mt-10 space-y-6 text-base leading-[1.8] text-stone-700">
            {(post.body || '').split('\n').map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        </div>

        <footer className="mt-16 border-t border-stone-100 pt-8">
          <div>
            <p className="font-medium text-stone-900">{post.author?.name ?? 'Unknown author'}</p>
            <p className="mt-0.5 text-xs text-stone-400">Author</p>
          </div>
        </footer>
      </article>
    </Layout>
  )
}
