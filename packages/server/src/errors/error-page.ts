/**
 * Generate a production-friendly HTML error page.
 * Shows status code, a generic message, and a link back to the home page.
 * No stack traces or internal details are exposed.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

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
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #fafaf9;
      color: #1c1917;
    }
    .container { text-align: center; padding: 2rem; }
    .status { font-size: 6rem; font-weight: 700; color: #d6d3d1; line-height: 1; }
    .title { font-size: 1.5rem; font-weight: 600; margin-top: 1rem; }
    .description { color: #78716c; margin-top: 0.5rem; max-width: 28rem; }
    .home-link {
      display: inline-block; margin-top: 2rem; padding: 0.625rem 1.5rem;
      background: #1c1917; color: #fff; border-radius: 0.375rem;
      text-decoration: none; font-size: 0.875rem; font-weight: 500;
    }
    .home-link:hover { background: #292524; }
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
