/** @jsxImportSource @guren/core */
import type { FC, PropsWithChildren } from '@guren/core'
import { Footer } from './Footer.js'
import { Header } from './Header.js'
import { Layout } from './Layout.js'

/**
 * The standard chrome for content pages. Pages wrap their `<main>` in this and
 * pass metadata through the `head` slot (see `Layout` for why the slot wins).
 */
export const ContentShell: FC<PropsWithChildren<{ head?: unknown }>> = ({ head, children }) => (
  <Layout head={head as never}>
    <Header />
    {children as never}
    <Footer />
  </Layout>
)
