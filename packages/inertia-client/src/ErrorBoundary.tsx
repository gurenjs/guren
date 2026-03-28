import { Component, type ReactNode, type ErrorInfo } from 'react'

interface ErrorBoundaryProps {
  /** Custom fallback UI to render when an error occurs */
  fallback?: ReactNode | ((error: Error) => ReactNode)
  /** Callback when an error is caught */
  onError?: (error: Error, errorInfo: ErrorInfo) => void
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * React error boundary that catches rendering errors in child components.
 * Provides a fallback UI and optional error reporting callback.
 *
 * @example
 * ```tsx
 * import { ErrorBoundary } from '@guren/inertia-client'
 *
 * <ErrorBoundary fallback={<div>Something went wrong</div>}>
 *   <App />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.props.onError?.(error, errorInfo)
  }

  render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(this.state.error)
      }
      if (this.props.fallback) {
        return this.props.fallback
      }
      return this.renderDefaultFallback()
    }
    return this.props.children
  }

  private renderDefaultFallback(): ReactNode {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        backgroundColor: '#fafaf9',
        color: '#1c1917',
      }}>
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <p style={{ fontSize: '4rem', fontWeight: 700, color: '#d6d3d1' }}>500</p>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginTop: '0.75rem' }}>
            Something went wrong
          </h1>
          <p style={{ color: '#78716c', marginTop: '0.5rem' }}>
            An unexpected error occurred. Please try refreshing the page.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '1.5rem',
              padding: '0.625rem 1.5rem',
              backgroundColor: '#1c1917',
              color: '#fff',
              border: 'none',
              borderRadius: '0.375rem',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Refresh Page
          </button>
        </div>
      </div>
    )
  }
}
