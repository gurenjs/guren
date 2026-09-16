import { defineHttpConfig } from '@guren/core'

const exclude = ['/health']

// The Host header is client-controlled, so production answers only to the host
// this app is deployed as, which APP_URL carries. Emailed links do not depend
// on this — app/Auth/AppUrl.ts resolves those per request and fails closed there.
export default defineHttpConfig((env) => ({
  hostAuthorization: process.env.NODE_ENV !== 'production'
    ? { allowedHosts: ['localhost:*', '127.0.0.1:*'], exclude }
    // Unreachable in production, where `.requiredInProduction()` failed the boot; it narrows the type.
    : env.APP_URL
      ? { allowedHosts: [`${new URL(env.APP_URL).hostname}:*`], exclude }
      : false,
}))
