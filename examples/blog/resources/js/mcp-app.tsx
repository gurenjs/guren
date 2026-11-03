import '../css/app.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from '@guren/inertia-client'
import type { StartMcpAppOptions } from '@guren/inertia-client/mcp-app'

// What every MCP App view mounts with (RFC 0038 §4). Owned by the app: keep its
// providers and stylesheet in step with resources/js/app.tsx.
export const setup: StartMcpAppOptions['setup'] = ({ el, App, props }) => {
  createRoot(el).render(
    React.createElement(ErrorBoundary, null,
      React.createElement(App, props as any),
    ),
  )
}
