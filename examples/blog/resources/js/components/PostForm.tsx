import React from 'react'
import { usePage, type InertiaFormProps } from '@inertiajs/react'
import Layout from './Layout.js'

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
      wrapperClassName="relative bg-linear-to-br from-[#FFF0F0] via-[#FFE3E3] to-[#F5C5C5] text-[#3C0A0A]"
      mainClassName="relative mx-auto w-full max-w-4xl px-4 sm:px-6 lg:px-8 py-12"
    >
      <div className="relative z-10 space-y-10">
        <section className="mx-auto flex w-full max-w-4xl flex-col gap-6 text-center md:flex-row md:items-center md:justify-between md:text-left">
          <div className="flex-1 space-y-3">
            <h1 className="text-4xl font-bold text-[#8F1111] md:text-5xl">
              {mode === 'create' ? 'Create a New Post' : 'Edit Post'}
            </h1>
          </div>
        </section>

        <div className="bg-white rounded-2xl shadow-xl border border-[#F4B0B0] overflow-hidden">
          <form onSubmit={handleSubmit} className="p-8 space-y-8">
            {generalError && (
              <div className="rounded-xl border border-[#F4B0B0] bg-[#FFF0F0] px-4 py-3 text-sm text-[#B71C1C] shadow-inner">
                {generalError}
              </div>
            )}

            {/* Title Field */}
            <div>
              <label htmlFor="title" className="block text-sm font-semibold text-[#8F1111] mb-3">
                Title
              </label>
              <input
                type="text"
                id="title"
                value={data.title}
                onChange={handleChange('title')}
                className={`w-full px-4 py-3 rounded-xl border-2 transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-[#B71C1C]/20 ${formErrors.title
                  ? 'border-red-300 focus:border-red-500'
                  : 'border-[#F6D1D1] focus:border-[#B71C1C]'
                  }`}
                placeholder="Enter a compelling title"
                disabled={processing}
              />
              {formErrors.title && (
                <p className="mt-2 text-sm text-red-600 flex items-center">
                  <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  {formErrors.title}
                </p>
              )}
            </div>

            {/* Excerpt Field */}
            <div>
              <label htmlFor="excerpt" className="block text-sm font-semibold text-[#8F1111] mb-3">
                Excerpt
              </label>
              <textarea
                id="excerpt"
                value={data.excerpt}
                onChange={handleChange('excerpt')}
                rows={3}
                className={`w-full px-4 py-3 rounded-xl border-2 transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-[#B71C1C]/20 resize-none ${formErrors.excerpt
                  ? 'border-red-300 focus:border-red-500'
                  : 'border-[#F6D1D1] focus:border-[#B71C1C]'
                  }`}
                placeholder="Briefly describe your post"
                disabled={processing}
              />
              {formErrors.excerpt && (
                <p className="mt-2 text-sm text-red-600 flex items-center">
                  <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  {formErrors.excerpt}
                </p>
              )}
            </div>

            {/* Body Field */}
            <div>
              <label htmlFor="body" className="block text-sm font-semibold text-[#8F1111] mb-3">
                Body
              </label>
              <textarea
                id="body"
                value={data.body}
                onChange={handleChange('body')}
                rows={12}
                className={`w-full px-4 py-3 rounded-xl border-2 transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-[#B71C1C]/20 resize-none ${formErrors.body
                  ? 'border-red-300 focus:border-red-500'
                  : 'border-[#F6D1D1] focus:border-[#B71C1C]'
                  }`}
                placeholder="Write the detailed content of your post here..."
                disabled={processing}
              />
              {formErrors.body && (
                <p className="mt-2 text-sm text-red-600 flex items-center">
                  <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  {formErrors.body}
                </p>
              )}
            </div>

            {/* Form Actions */}
            <div className="flex flex-col sm:flex-row gap-4 pt-6 border-t border-[#F4B0B0]">
              <button
                type="submit"
                disabled={processing}
                className="flex-1 inline-flex items-center justify-center px-6 py-3 text-base font-semibold text-white bg-linear-to-r from-[#B71C1C] to-[#8F1111] rounded-xl hover:from-[#C92A2A] hover:to-[#7A0F0F] focus:outline-none focus:ring-4 focus:ring-[#B71C1C]/20 transition-all duration-200 shadow-lg shadow-[#B71C1C]/30 hover:shadow-xl transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
              >
                {processing ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    {mode === 'create' ? 'Creating...' : 'Updating...'}
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    {mode === 'create' ? 'Create Post' : 'Update Post'}
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={onCancel}
                disabled={processing}
                className="flex-1 sm:flex-none inline-flex items-center justify-center px-6 py-3 text-base font-semibold text-[#8F1111] bg-white border-2 border-[#F4B0B0] rounded-xl hover:bg-[#FFF0F0] hover:border-[#DC7C7C] focus:outline-none focus:ring-4 focus:ring-[#E35151]/20 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Background Decorations */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-40 -right-40 h-80 w-80 rounded-full bg-[#F5C5C5] opacity-30 blur-xl mix-blend-multiply animate-blob"></div>
        <div className="absolute -bottom-40 -left-40 h-80 w-80 rounded-full bg-[#E35151] opacity-20 blur-xl mix-blend-multiply animate-blob animation-delay-2000"></div>
        <div className="absolute top-40 left-40 h-80 w-80 rounded-full bg-[#FF9D9D] opacity-20 blur-xl mix-blend-multiply animate-blob animation-delay-4000"></div>
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
          @keyframes blob {
            0% {
              transform: translate(0px, 0px) scale(1);
            }
            33% {
              transform: translate(30px, -50px) scale(1.1);
            }
            66% {
              transform: translate(-20px, 20px) scale(0.9);
            }
            100% {
              transform: translate(0px, 0px) scale(1);
            }
          }
          .animate-blob {
            animation: blob 7s infinite;
          }
          .animation-delay-2000 {
            animation-delay: 2s;
          }
          .animation-delay-4000 {
            animation-delay: 4s;
          }
        `
        }}
      />
    </Layout>
  )
}
