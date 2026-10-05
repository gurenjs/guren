function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Production error page: no stack traces or internal details are exposed. */
export function renderErrorPage(statusCode: number, message?: string): string {
  const title = STATUS_TITLES[statusCode] ?? 'Error'
  const description = escapeHtml(
    message ?? STATUS_DESCRIPTIONS[statusCode] ?? 'An unexpected error occurred.'
  )

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${statusCode} ${title}</title>
  <style>
    /* Guren UI's tokens (github.com/gurenjs/guren-ui); the link home is the screen's one crimson fill. */
    :root {
      color-scheme: light;
      --g-page: #ffffff; --g-heading: #111827; --g-text-2: #4b5563; --g-line-strong: #d1d5db;
      --g-accent: #db1b1b; --g-accent-down: #b91c1c; --g-on-accent: #fff5f5;
    }
    @media (prefers-color-scheme: dark) {
      :root { color-scheme: dark; --g-page: #1a1a2e; --g-heading: #e0def4; --g-text-2: #908caa; --g-line-strong: #3d3d5c; }
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Noto Sans JP', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--g-page);
      color: var(--g-heading);
      -webkit-font-smoothing: antialiased;
    }
    .container { text-align: center; padding: 2rem; }
    .status { font: 700 6rem/1 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace; color: var(--g-line-strong); }
    .title { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.01em; margin-top: 1rem; }
    .description { color: var(--g-text-2); margin-top: 0.5rem; max-width: 28rem; }
    .home-link {
      display: inline-block; margin-top: 2rem; padding: 8px 16px;
      background: var(--g-accent); color: var(--g-on-accent); border-radius: 8px;
      text-decoration: none; font-size: 13.5px; font-weight: 700;
    }
    .home-link:hover { background: var(--g-accent-down); }
    .home-link:focus-visible { outline: 2px solid var(--g-accent); outline-offset: 2px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="status">${statusCode}</div>
    <h1 class="title">${title}</h1>
    <p class="description">${description}</p>
    <a href="/" class="home-link">Go Home</a>
  </div>
</body>
</html>`
}

const STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  419: 'Page Expired',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

const STATUS_DESCRIPTIONS: Record<number, string> = {
  400: 'The request could not be understood by the server.',
  401: 'You need to sign in to access this page.',
  403: 'You do not have permission to access this page.',
  404: 'The page you are looking for could not be found.',
  405: 'The request method is not supported for this page.',
  419: 'Your session has expired. Please refresh and try again.',
  422: 'The submitted data was invalid.',
  429: 'You are making too many requests. Please slow down.',
  500: 'Something went wrong on our end. Please try again later.',
  502: 'The server received an invalid response from an upstream server.',
  503: 'The service is temporarily unavailable. Please try again later.',
  504: 'The server did not receive a timely response from an upstream server.',
}
