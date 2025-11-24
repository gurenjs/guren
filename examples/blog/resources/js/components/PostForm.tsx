import React from 'react'
import { usePage, type InertiaFormProps } from '@inertiajs/react'
import Layout from './Layout.js'
import { Save, X, AlertCircle } from 'lucide-react'

export type PostFormValues = {
  title: string
  excerpt: string
  body: string
}

type PostFormProps = {
  form: InertiaFormProps<PostFormValues>
  onSubmit: (data: PostFormValues) => void
  onCancel: () => void
  mode: 'create' | 'edit'
}

export default function PostForm({ form, onSubmit, onCancel, mode }: PostFormProps) {
  const { data, setData, errors: formErrors, clearErrors, setError, processing } = form
  const { props } = usePage<{ errors?: Record<string, string | undefined> }>()
  const generalError = (formErrors as Record<string, string | undefined>).message

  React.useEffect(() => {
    const serverErrors = props.errors ?? {}
    const serverErrorKeys = Object.keys(serverErrors)
    const formErrorMap = formErrors as Record<string, string | undefined>
    const formErrorKeys = Object.keys(formErrorMap)

    if (serverErrorKeys.length > 0) {
      const needsSync =
        serverErrorKeys.length !== formErrorKeys.length ||
        serverErrorKeys.some((key) => formErrorMap[key] !== serverErrors[key])

      if (needsSync) {
        const sanitizedServerErrors: Record<string, string> = {}

        serverErrorKeys.forEach((key) => {
          const value = serverErrors[key]

          if (typeof value === 'string') {
            sanitizedServerErrors[key] = value
          }
        })

        if (Object.keys(sanitizedServerErrors).length > 0) {
          setError(sanitizedServerErrors)
        }
      }
      return
    }

    if (formErrorKeys.length > 0) {
      clearErrors()
    }
  }, [props.errors, formErrors, setError, clearErrors])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    clearErrors()

    onSubmit({
      title: data.title,
      excerpt: data.excerpt,
      body: data.body
    })
  }

  const handleChange = (field: keyof PostFormValues) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    setData(field, e.target.value)

    if (formErrors[field]) {
      clearErrors(field)
    }
  }

  return (
    <Layout
      wrapperClassName="bg-zinc-50"
      mainClassName="max-w-4xl mx-auto px-6 py-12"
    >
      <div className="space-y-8">
        <section className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
            {mode === 'create' ? 'Create a New Post' : 'Edit Post'}
          </h1>
          <p className="text-lg text-zinc-500">
            {mode === 'create'
              ? 'Share your thoughts with the world.'
              : 'Update your post content.'}
          </p>
        </section>

        <div className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-zinc-200">
          <form onSubmit={handleSubmit} className="space-y-8">
            {generalError && (
              <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                <AlertCircle className="h-4 w-4" />
                {generalError}
              </div>
            )}

            {/* Title Field */}
            <div className="space-y-2">
              <label htmlFor="title" className="block text-sm font-medium text-zinc-900">
                Title
              </label>
              <input
                type="text"
                id="title"
                value={data.title}
                onChange={handleChange('title')}
                className={`block w-full rounded-lg border-0 py-2.5 px-3 text-zinc-900 shadow-sm ring-1 ring-inset placeholder:text-zinc-400 focus:ring-2 focus:ring-inset sm:text-sm sm:leading-6 ${formErrors.title
                  ? 'ring-red-300 focus:ring-red-500'
                  : 'ring-zinc-300 focus:ring-guren-600'
                  }`}
                placeholder="Enter a compelling title"
                disabled={processing}
              />
              {formErrors.title && (
                <p className="flex items-center gap-1 text-sm text-red-600">
                  <AlertCircle className="h-4 w-4" />
                  {formErrors.title}
                </p>
              )}
            </div>

            {/* Excerpt Field */}
            <div className="space-y-2">
              <label htmlFor="excerpt" className="block text-sm font-medium text-zinc-900">
                Excerpt
              </label>
              <textarea
                id="excerpt"
                value={data.excerpt}
                onChange={handleChange('excerpt')}
                rows={3}
                className={`block w-full rounded-lg border-0 py-2.5 px-3 text-zinc-900 shadow-sm ring-1 ring-inset placeholder:text-zinc-400 focus:ring-2 focus:ring-inset sm:text-sm sm:leading-6 resize-none ${formErrors.excerpt
                  ? 'ring-red-300 focus:ring-red-500'
                  : 'ring-zinc-300 focus:ring-guren-600'
                  }`}
                placeholder="Briefly describe your post"
                disabled={processing}
              />
              {formErrors.excerpt && (
                <p className="flex items-center gap-1 text-sm text-red-600">
                  <AlertCircle className="h-4 w-4" />
                  {formErrors.excerpt}
                </p>
              )}
            </div>

            {/* Body Field */}
            <div className="space-y-2">
              <label htmlFor="body" className="block text-sm font-medium text-zinc-900">
                Body
              </label>
              <textarea
                id="body"
                value={data.body}
                onChange={handleChange('body')}
                rows={12}
                className={`block w-full rounded-lg border-0 py-2.5 px-3 text-zinc-900 shadow-sm ring-1 ring-inset placeholder:text-zinc-400 focus:ring-2 focus:ring-inset sm:text-sm sm:leading-6 resize-y ${formErrors.body
                  ? 'ring-red-300 focus:ring-red-500'
                  : 'ring-zinc-300 focus:ring-guren-600'
                  }`}
                placeholder="Write the detailed content of your post here..."
                disabled={processing}
              />
              {formErrors.body && (
                <p className="flex items-center gap-1 text-sm text-red-600">
                  <AlertCircle className="h-4 w-4" />
                  {formErrors.body}
                </p>
              )}
            </div>

            {/* Form Actions */}
            <div className="flex flex-col-reverse gap-4 border-t border-zinc-100 pt-6 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={onCancel}
                disabled={processing}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-6 py-2.5 text-sm font-medium text-zinc-700 shadow-sm ring-1 ring-inset ring-zinc-300 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="h-4 w-4" />
                Cancel
              </button>

              <button
                type="submit"
                disabled={processing}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-guren-600 px-6 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-guren-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-guren-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {processing ? (
                  <>
                    <svg className="h-4 w-4 animate-spin text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    {mode === 'create' ? 'Creating...' : 'Updating...'}
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    {mode === 'create' ? 'Create Post' : 'Update Post'}
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Layout>
  )
}
