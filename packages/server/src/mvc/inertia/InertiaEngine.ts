import { isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureErrorStackTracePolyfill } from "../../support/error-polyfill";
import { parseImportMap } from "../../support/import-map";

ensureErrorStackTracePolyfill();

export interface InertiaOptions {
  readonly url?: string;
  readonly version?: string;
  readonly status?: number;
  readonly headers?: HeadersInit;
  readonly request?: Request;
  readonly title?: string;
  readonly entry?: string;
  readonly importMap?: Record<string, string>;
  readonly styles?: string[];
  readonly ssr?: InertiaSsrOptions;
}

export interface InertiaPagePayload {
  component: string;
  props: Record<string, unknown>;
  url: string;
  version?: string;
}

export interface InertiaSsrContext {
  page: InertiaPagePayload;
  request?: Request;
  manifest?: string;
}

export interface InertiaSsrResult {
  head: string[];
  body: string;
}

export type InertiaSsrRenderer = (
  context: InertiaSsrContext
) => Promise<InertiaSsrResult> | InertiaSsrResult;

export interface InertiaSsrOptions {
  enabled?: boolean;
  entry?: string;
  manifest?: string;
  render?: InertiaSsrRenderer;
}

const DEFAULT_TITLE = "Guren";
const DEFAULT_IMPORT_MAP: Record<string, string> = {
  react: "https://esm.sh/react@19.0.0?dev",
  "react/jsx-runtime": "https://esm.sh/react@19.0.0/jsx-runtime?dev",
  "react/jsx-dev-runtime": "https://esm.sh/react@19.0.0/jsx-dev-runtime?dev",
  "react-dom/client": "https://esm.sh/react-dom@19.0.0/client?dev",
  "@guren/inertia-client": "/vendor/inertia-client.tsx",
  "@inertiajs/react":
    "https://esm.sh/@inertiajs/react@2.2.15?dev&external=react,react-dom/client",
};

export async function inertia(
  component: string,
  props: Record<string, unknown>,
  options: InertiaOptions = {}
): Promise<Response> {
  const page: InertiaPagePayload = {
    component,
    props,
    url: options.url ?? "",
    version: options.version,
  };

  const request = options.request;
  const isInertiaVisit = Boolean(request?.headers.get("X-Inertia"));
  const prefersJson = request ? acceptsJson(request) : false;

  if (isInertiaVisit || prefersJson) {
    return new Response(serializePage(page), {
      status: options.status ?? 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Inertia": "true",
        Vary: "Accept",
        ...(options.version ? { "X-Inertia-Version": options.version } : {}),
        ...options.headers,
      },
    });
  }

  const html = await renderDocument(page, options);

  return new Response(html, {
    status: options.status ?? 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Inertia": "true",
      Vary: "Accept",
      ...(options.version ? { "X-Inertia-Version": options.version } : {}),
      ...options.headers,
    },
  });
}

async function renderDocument(
  page: InertiaPagePayload,
  options: InertiaOptions
): Promise<string> {
  const defaultEntry =
    process.env.GUREN_INERTIA_ENTRY ?? "/resources/js/app.tsx";
  const entry = options.entry ?? defaultEntry;
  const title = escapeHtml(options.title ?? DEFAULT_TITLE);
  const styles =
    options.styles ?? parseStylesEnv(process.env.GUREN_INERTIA_STYLES);
  const envImportMap = parseImportMap(process.env.GUREN_INERTIA_IMPORT_MAP, {
    context: "GUREN_INERTIA_IMPORT_MAP",
  });
  const importMap = JSON.stringify(
    {
      imports: {
        ...DEFAULT_IMPORT_MAP,
        ...envImportMap,
        ...(options.importMap ?? {}),
      },
    },
    null,
    2
  );
  const serializedPage = serializePage(page);
  const stylesheetLinks = renderStyles(styles);
  const ssrResult = await tryRenderSsr(page, options);
  const headElements = (ssrResult?.head ?? []).map(normalizeHeadElement);
  const hasCustomTitle = headElements.some((element) =>
    /<title\b[^>]*>/iu.test(element)
  );
  const headSegments = [
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    hasCustomTitle ? "" : `<title>${title}</title>`,
    stylesheetLinks,
    ...headElements,
    `<script type="importmap">${importMap}</script>`,
    `<script>window.__INERTIA_PAGE__ = ${serializedPage};</script>`,
  ].filter((segment) => segment && segment.length > 0);
  const appMarkup =
    ssrResult?.body ??
    `<div id="app" data-page="${escapeAttribute(serializedPage)}"></div>`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    ${headSegments.join("\n    ")}
  </head>
  <body>
    ${appMarkup}
    <script type="module" src="${entry}"></script>
  </body>
</html>`;
}

async function tryRenderSsr(
  page: InertiaPagePayload,
  options: InertiaOptions
): Promise<InertiaSsrResult | undefined> {
  const ssrOptions = options.ssr;

  if (ssrOptions?.enabled === false) {
    return undefined;
  }

  const manifest =
    (ssrOptions?.manifest ?? process.env.GUREN_INERTIA_SSR_MANIFEST)?.trim() ||
    undefined;

  const renderer =
    ssrOptions?.render ??
    (await loadSsrRenderer(
      ssrOptions?.entry ?? process.env.GUREN_INERTIA_SSR_ENTRY
    ));

  if (!renderer) {
    return undefined;
  }

  try {
    const result = await renderer({
      page,
      request: options.request,
      manifest,
    });

    if (!result || typeof result.body !== "string") {
      return undefined;
    }

    return {
      body: result.body,
      head: Array.isArray(result.head) ? result.head : [],
    };
  } catch (error) {
    console.error(
      "Inertia SSR renderer failed; falling back to client rendering.",
      error
    );
    return undefined;
  }
}

async function loadSsrRenderer(
  entry: string | undefined
): Promise<InertiaSsrRenderer | undefined> {
  const specifier = entry?.trim();

  if (!specifier) {
    return undefined;
  }

  const normalized = normalizeSsrSpecifier(specifier);

  try {
    const module = await import(normalized);
    const renderCandidate = extractSsrRenderer(module);

    if (!renderCandidate) {
      console.warn(
        `Inertia SSR entry "${specifier}" does not export a renderer. Expected a default export or a named "render" function.`
      );
      return undefined;
    }

    return renderCandidate;
  } catch (error) {
    console.error(`Failed to import Inertia SSR entry "${specifier}".`, error);
    return undefined;
  }
}

function extractSsrRenderer(module: unknown): InertiaSsrRenderer | undefined {
  if (!module || typeof module !== "object") {
    return undefined;
  }

  const candidate =
    typeof (module as Record<string, unknown>).render === "function"
      ? (module as Record<string, InertiaSsrRenderer>).render
      : typeof (module as Record<string, unknown>).default === "function"
        ? (module as Record<string, InertiaSsrRenderer>).default
        : undefined;

  if (!candidate) {
    return undefined;
  }

  return (context) => Promise.resolve(candidate(context));
}

function normalizeSsrSpecifier(specifier: string): string {
  if (specifier.startsWith("file://") || isUrlLike(specifier)) {
    return specifier;
  }

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const absolute = resolvePath(process.cwd(), specifier);
    return pathToFileURL(absolute).href;
  }

  if (isAbsolute(specifier)) {
    return pathToFileURL(specifier).href;
  }

  return specifier;
}

function isUrlLike(specifier: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(specifier);
}

function renderStyles(styles: string[]): string {
  if (!styles.length) {
    return "";
  }

  return styles
    .map((href) => `<link rel="stylesheet" href="${escapeAttribute(href)}" />`)
    .join("\n    ");
}
function normalizeHeadElement(element: unknown): string {
  const markup = typeof element === "string" ? element : String(element ?? "");
  const pattern = /href="\/(?!public\/)([^"?]+\.(?:js|css))(\?[^"']*)?"/g;

  return markup.replace(
    pattern,
    (_match, file, query = "") => `href="/public/assets/${file}${query}"`
  );
}

function serializePage(page: InertiaPagePayload): string {
  return JSON.stringify(page).replace(/[<\u2028\u2029]/gu, (char) => {
    switch (char) {
      case "<":
        return "\\u003c";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return char;
    }
  });
}

function acceptsJson(request: Request): boolean {
  const accept = request.headers.get("accept")?.toLowerCase() ?? "";

  if (!accept || accept === "*/*") {
    return false;
  }

  if (accept.includes("text/html")) {
    return false;
  }

  return accept.includes("application/json") || accept.includes("json");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function escapeAttribute(value: string): string {
  return value.replace(/[&"]/gu, (char) => {
    if (char === "&") {
      return "&amp;";
    }

    return "&quot;";
  });
}

function parseStylesEnv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
