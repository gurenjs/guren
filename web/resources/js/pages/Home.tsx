import { Head } from '@inertiajs/react'

interface HomeProps {
  message: string
}

export default function Home({ message }: HomeProps) {
  return (
    <>
      <Head title="Web" />
      <main style={{ fontFamily: 'system-ui, sans-serif', margin: '4rem auto', maxWidth: '640px' }}>
        <h1 style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>{message}</h1>
        <p style={{ fontSize: '1.125rem', lineHeight: 1.6 }}>
          Edit <code>resources/js/pages/Home.tsx</code> or <code>app/Http/Controllers/HomeController.ts</code> to get started.
        </p>
      </main>
    </>
  )
}
