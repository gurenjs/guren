import React from 'react'
import { usePage, type InertiaFormProps } from '@inertiajs/react'
import Layout from './Layout.js'
import AttachmentImage from './AttachmentImage.js'
import { AlertCircle } from 'lucide-react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { AttachmentData } from '@guren/core'

// Inertia switches the request to FormData as soon as the data holds a File.
export type PostFormValues = ApiRoutes['posts.store']['body'] & { cover?: File | null }

type PostFormProps = {
  form: InertiaFormProps<PostFormValues>
  onSubmit: (data: PostFormValues) => void
  onCancel: () => void
  onDelete?: () => void
  mode: 'create' | 'edit'
  currentCover?: AttachmentData | null
}

export default function PostForm({ form, onSubmit, onCancel, onDelete, mode, currentCover = null }: PostFormProps) {
  const { data, setData, errors: formErrors, clearErrors, setError, processing } = form
  const { props } = usePage<{ errors?: Record<string, string | undefined> }>()
  const generalError = (formErrors as Record<string, string | undefined>).message

  const [coverPreview, setCoverPreview] = React.useState<string | null>(null)

  // The effect cleanup owns every revoke: it runs with the previous URL on both
  // a new pick and unmount.
  React.useEffect(() => {
    return () => {
      if (coverPreview) {
        URL.revokeObjectURL(coverPreview)
      }
    }
  }, [coverPreview])

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

    const formData = new FormData(e.currentTarget as HTMLFormElement)
    const payload: PostFormValues = {
      title: String(formData.get('title') ?? ''),
      excerpt: String(formData.get('excerpt') ?? ''),
      body: String(formData.get('body') ?? ''),
    }

    const cover = formData.get('cover')
    if (cover instanceof File && cover.size > 0) {
      payload.cover = cover
    }

    setData(payload)
    onSubmit(payload)
  }

  // The submitted file comes from the form's own FormData; React state holds
  // only the preview URL.
  const handleCoverChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    setCoverPreview(file ? URL.createObjectURL(file) : null)

    if ((formErrors as Record<string, string | undefined>).cover) {
      clearErrors('cover' as keyof PostFormValues)
    }
  }

  const coverError = (formErrors as Record<string, string | undefined>).cover

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
      mainClassName="max-w-4xl mx-auto px-6 pt-10 pb-16 sm:pt-12 sm:pb-24"
    >
      <div className="space-y-10">
        <section>
          <h1 className="text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">
            {mode === 'create' ? 'New Post' : 'Edit Post'}
          </h1>
          <p className="mt-3 text-base text-stone-400">
            {mode === 'create'
              ? 'Share your thoughts with the world.'
              : 'Update your post content.'}
          </p>
        </section>

        <div className="rounded-lg bg-white p-8 shadow-sm sm:p-10">
          <form onSubmit={handleSubmit} className="space-y-8">
            {generalError && (
              <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {generalError}
              </div>
            )}

            <div className="space-y-2">
              <label htmlFor="title" className="block text-sm font-medium text-stone-700">
                Title
              </label>
              <input
                type="text"
                id="title"
                name="title"
                value={data.title}
                onChange={handleChange('title')}
                className={`block w-full rounded-md border-0 px-3 py-2.5 text-xl font-medium text-stone-900 shadow-sm ring-1 ring-inset placeholder:text-stone-300 focus:ring-2 focus:ring-inset sm:leading-8 ${formErrors.title
                  ? 'ring-red-300 focus:ring-red-500'
                  : 'ring-stone-200 focus:ring-stone-900'
                  }`}
                placeholder="Enter a compelling title"
                disabled={processing}
              />
              {formErrors.title && (
                <p className="flex items-center gap-1 text-sm text-red-600">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {formErrors.title}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="cover" className="block text-sm font-medium text-stone-700">
                Cover image
              </label>
              {coverPreview ? (
                <img
                  src={coverPreview}
                  alt="Cover preview"
                  data-testid="cover-preview"
                  className="h-40 w-full rounded-md object-cover ring-1 ring-stone-200"
                />
              ) : currentCover && (
                <AttachmentImage
                  attachment={currentCover}
                  variant="thumb"
                  alt="Current cover"
                  testId="cover-preview"
                  className="h-40 w-full rounded-md object-cover ring-1 ring-stone-200"
                />
              )}
              <input
                type="file"
                id="cover"
                name="cover"
                accept="image/*"
                onChange={handleCoverChange}
                className="block w-full text-sm text-stone-500 file:mr-4 file:rounded-md file:border-0 file:bg-stone-100 file:px-4 file:py-2 file:text-sm file:font-medium file:text-stone-700 hover:file:bg-stone-200"
                disabled={processing}
              />
              <p className="text-xs text-stone-400">
                {mode === 'edit' && currentCover
                  ? 'Choosing a new image replaces the current cover.'
                  : 'Optional. Images only — a 320px thumbnail is generated automatically.'}
              </p>
              {coverError && (
                <p className="flex items-center gap-1 text-sm text-red-600">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {coverError}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="excerpt" className="block text-sm font-medium text-stone-700">
                Excerpt
              </label>
              <textarea
                id="excerpt"
                name="excerpt"
                value={data.excerpt}
                onChange={handleChange('excerpt')}
                rows={3}
                className={`block w-full rounded-md border-0 px-3 py-2.5 text-stone-900 shadow-sm ring-1 ring-inset placeholder:text-stone-300 focus:ring-2 focus:ring-inset sm:text-sm sm:leading-6 resize-none ${formErrors.excerpt
                  ? 'ring-red-300 focus:ring-red-500'
                  : 'ring-stone-200 focus:ring-stone-900'
                  }`}
                placeholder="Briefly describe your post"
                disabled={processing}
              />
              {formErrors.excerpt && (
                <p className="flex items-center gap-1 text-sm text-red-600">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {formErrors.excerpt}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="body" className="block text-sm font-medium text-stone-700">
                Body
              </label>
              <textarea
                id="body"
                name="body"
                value={data.body}
                onChange={handleChange('body')}
                rows={16}
                className={`block w-full rounded-md border-0 px-3 py-2.5 text-stone-900 shadow-sm ring-1 ring-inset placeholder:text-stone-300 focus:ring-2 focus:ring-inset sm:text-sm sm:leading-relaxed resize-y ${formErrors.body
                  ? 'ring-red-300 focus:ring-red-500'
                  : 'ring-stone-200 focus:ring-stone-900'
                  }`}
                placeholder="Write the detailed content of your post here..."
                disabled={processing}
              />
              {formErrors.body && (
                <p className="flex items-center gap-1 text-sm text-red-600">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {formErrors.body}
                </p>
              )}
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-stone-100 pt-6 sm:flex-row sm:justify-end">
              {onDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={processing}
                  className="inline-flex items-center justify-center rounded-md bg-white px-5 py-2.5 text-sm font-medium text-red-600 ring-1 ring-inset ring-red-200 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 sm:mr-auto"
                >
                  Delete Post
                </button>
              )}
              <button
                type="button"
                onClick={onCancel}
                disabled={processing}
                className="inline-flex items-center justify-center rounded-md bg-white px-5 py-2.5 text-sm font-medium text-stone-700 ring-1 ring-inset ring-stone-200 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={processing}
                className="inline-flex items-center justify-center rounded-md bg-stone-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {processing ? (
                  <>
                    <svg className="mr-2 h-4 w-4 animate-spin text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    {mode === 'create' ? 'Creating...' : 'Updating...'}
                  </>
                ) : (
                  mode === 'create' ? 'Create Post' : 'Update Post'
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Layout>
  )
}
