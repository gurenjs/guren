import Layout from '../components/Layout'

interface Props {
  status: number
  message?: string
}

const titles: Record<number, string> = {
  404: 'Page Not Found',
  403: 'Forbidden',
  500: 'Server Error',
  503: 'Service Unavailable',
}

const descriptions: Record<number, string> = {
  404: 'The page you are looking for could not be found.',
  403: 'You do not have permission to access this page.',
  500: 'Something went wrong on our end.',
  503: 'We are currently undergoing maintenance.',
}

export default function Error({ status, message }: Props) {
  const title = titles[status] ?? 'Error'
  const description = message ?? descriptions[status] ?? 'An unexpected error occurred.'

  return (
    <Layout mainClassName="flex-1 flex items-center justify-center">
      <div className="text-center py-20">
        <p className="text-8xl font-bold text-stone-200">{status}</p>
        <h1 className="mt-4 text-2xl font-semibold text-stone-900">{title}</h1>
        <p className="mt-2 text-stone-500">{description}</p>
        <a
          href="/"
          className="mt-8 inline-block rounded-md bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-800"
        >
          Go Home
        </a>
      </div>
    </Layout>
  )
}
