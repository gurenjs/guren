let patched = false

/**
 * Bun 1.x tightened Error.captureStackTrace so it throws unless the first argument is an actual
 * Error instance. Some ecosystem packages (notably follow-redirects) still pass plain objects,
 * because Node silently upgrades them. When those packages execute during SSR boot we end up
 * crashing before Inertia can import the SSR entry. This shim mirrors Node's behavior by copying
 * a stack trace from a real Error onto whatever object was provided, ensuring third-party code
 * keeps working regardless of Bun's stricter contract.
 */
export function ensureErrorStackTracePolyfill(): void {
  if (patched) {
    return
  }

  const capture = (Error as typeof Error & { captureStackTrace?: typeof Error.captureStackTrace }).captureStackTrace

  if (typeof capture !== 'function') {
    ; (Error as any).captureStackTrace = (target: any) => copyStackFromNewError(target)
    patched = true
    return
  }

  ; (Error as any).captureStackTrace = (target: any, constructorOpt?: (...args: any[]) => any) => {
    // Let Bun handle genuine Errors so we retain native stack formatting when possible.
    if (target instanceof Error) {
      try {
        return capture(target, constructorOpt)
      } catch {
        // Bun 1.3.1 still throws in some edge cases, so we fall back to cloning below.
      }
    }

    const placeholder = new Error()
    capture(placeholder, constructorOpt)
    copyStackFromError(target, placeholder)
    return target
  }

  patched = true
}

function copyStackFromNewError(target: any): void {
  const placeholder = new Error()
  copyStackFromError(target, placeholder)
}

function copyStackFromError(target: any, source: Error): void {
  if (!target || typeof target !== 'object') {
    return
  }

  // Directly defining non-enumerable properties to match native Error behavior.
  if (source.stack) {
    Object.defineProperty(target, 'stack', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: source.stack,
    })
  }

  // Also copy name and message for completeness.
  if (source.name && !('name' in target)) {
    Object.defineProperty(target, 'name', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: source.name,
    })
  }

  if (source.message && !('message' in target)) {
    Object.defineProperty(target, 'message', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: source.message,
    })
  }
}
