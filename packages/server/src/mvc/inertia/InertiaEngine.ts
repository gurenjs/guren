import { isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureErrorStackTracePolyfill } from "../../support/error-polyfill";
import { parseImportMap } from "../../support/import-map";
import { DEFAULT_DEV_STYLES_ENTRY } from "../../support/inertia-defaults";

ensureErrorStackTracePolyfill();

/**
 * Per-response form of {@link InertiaDocumentOptions}, already resolved to
 * strings. Each field overrides the app-wide {@link setInertiaDocument} default.
 */
type InertiaDocumentOverrides = {
  readonly [K in keyof InertiaDocumentOptions]?: string;
};

export interface InertiaOptions extends InertiaDocumentOverrides {
  readonly url?: string;
  readonly version?: string;
  readonly status?: number;
  readonly headers?: HeadersInit;
  readonly request?: Request;
  readonly title?: string;
  /** Value for the root `<html lang>` attribute. Defaults to "en". */
  readonly lang?: string;
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

export interface InertiaDocumentContext {
  /** Page component being rendered, e.g. `"Docs/Show"`. */
  readonly component: string;
}

type InertiaDocumentValue =
  | string
  | ((context: InertiaDocumentContext) => string | undefined);

export interface InertiaDocumentOptions {
  /** Class for the root `<body>`; a function varies it per page component. */
  readonly bodyClass?: InertiaDocumentValue;
  /**
   * CSS inlined into `<head>` ahead of the stylesheet links. Keep it to the few
   * declarations that decide the first paint; the main stylesheet wins later.
   */
  readonly criticalCss?: InertiaDocumentValue;
  /**
   * Body of a blocking inline `<script>` run before the first paint — theme
   * prepaint logic reading `localStorage` or `matchMedia` before hydration.
   */
  readonly prepaintScript?: InertiaDocumentValue;
  /**
   * Raw markup inlined into `<head>`, ahead of the critical CSS. Unescaped —
   * the app author owns this string. For static site-wide tags like favicons.
   */
  readonly head?: InertiaDocumentValue;
}

let documentOptions: InertiaDocumentOptions | undefined;

/**
 * Register app-wide document defaults for server-rendered Inertia responses;
 * call it at module scope in the app entry so every runtime picks it up.
 * Process-wide, not request-scoped: calling it mid-flight leaks the policy into
 * in-flight requests — use the {@link InertiaOptions} fields per response.
 * Values are emitted verbatim, so never pass user input. `undefined` clears
 * (test isolation).
 */
export function setInertiaDocument(
  options: InertiaDocumentOptions | undefined
): void {
  documentOptions = options;
}

let defaultSsrRenderer: InertiaSsrRenderer | undefined;

/**
 * Register a process-wide default SSR renderer, for adapters whose bundler
 * cannot resolve a runtime path (Workers has no filesystem for
 * `GUREN_INERTIA_SSR_ENTRY`'s dynamic import). Per-call `ssr.render` still
 * wins; `undefined` clears (test isolation).
 */
export function setInertiaSsrRenderer(
  renderer: InertiaSsrRenderer | undefined
): void {
  defaultSsrRenderer = renderer;
}

const DEFAULT_TITLE = "Guren";
// Dev-only fallback used when serving unbundled sources; production builds
// bundle React into the Vite assets and must not pull esm.sh dev builds.
const DEV_FALLBACK_IMPORT_MAP: Record<string, string> = {
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
  const resolvedVersion =
    options.version ?? process.env.GUREN_INERTIA_VERSION ?? undefined;

  const page: InertiaPagePayload = {
    component,
    props,
    url: options.url ?? inertiaPageUrl(options.request) ?? "",
    version: resolvedVersion,
  };

  const request = options.request;
  const isInertiaVisit = Boolean(request?.headers.get("X-Inertia"));
  const prefersJson = request ? acceptsJson(request) : false;
  const versionHeader: Record<string, string> = resolvedVersion
    ? { "X-Inertia-Version": resolvedVersion }
    : {};

  if (
    request &&
    resolvedVersion &&
    isInertiaVisit &&
    request.method === "GET"
  ) {
    const clientVersion = request.headers.get("X-Inertia-Version");
    if (clientVersion !== resolvedVersion) {
      return new Response(null, {
        status: 409,
        headers: {
          "X-Inertia-Location": options.url ?? request.url,
          Vary: "Accept",
        },
      });
    }
  }

  if (isInertiaVisit || prefersJson) {
    return new Response(serializePage(page), {
      status: options.status ?? 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Inertia": "true",
        Vary: "Accept",
        ...versionHeader,
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
      ...versionHeader,
      ...options.headers,
    },
  });
}

/**
 * The Inertia protocol's page `url` is the request path plus query string, kept
 * relative. Derived from the request when the caller does not override it.
 */
function inertiaPageUrl(request: Request | undefined): string | undefined {
  if (!request) {
    return undefined;
  }

  const { pathname, search } = new URL(request.url);
  return `${pathname}${search}`;
}

async function renderDocument(
  page: InertiaPagePayload,
  options: InertiaOptions
): Promise<string> {
  const defaultEntry =
    process.env.GUREN_INERTIA_ENTRY ?? "/resources/js/app.tsx";
  const entry = options.entry ?? defaultEntry;
  const title = escapeHtml(options.title ?? DEFAULT_TITLE);
  const isProduction = process.env.NODE_ENV === "production";
  const configuredStyles =
    options.styles ?? parseStylesEnv(process.env.GUREN_INERTIA_STYLES);
  // The dev-default stylesheet points at the *source* file, which only works
  // when nothing has to compile it: with a Vite dev server on the entry the CSS
  // already arrives through the module graph, and Tailwind's `@import
  // 'tailwindcss'` is a bare specifier the browser 404s. An explicit
  // `options.styles` is never filtered; only env-derived styles are.
  const styles =
    !isProduction && options.styles === undefined && isDevServerEntry(entry)
      ? configuredStyles.filter((href) => href !== DEFAULT_DEV_STYLES_ENTRY)
      : configuredStyles;
  const envImportMap = parseImportMap(process.env.GUREN_INERTIA_IMPORT_MAP, {
    context: "GUREN_INERTIA_IMPORT_MAP",
  });
  const importMapEntries = {
    ...(isProduction ? {} : DEV_FALLBACK_IMPORT_MAP),
    ...envImportMap,
    ...options.importMap,
  };
  const importMap = JSON.stringify({ imports: importMapEntries }, null, 2);
  const serializedPage = serializePage(page);
  const stylesheetLinks = renderStyles(styles);
  const criticalCss = resolveDocumentValue(
    "criticalCss",
    options,
    page.component
  );
  const prepaintScript = resolveDocumentValue(
    "prepaintScript",
    options,
    page.component
  );
  const headMarkup = resolveDocumentValue("head", options, page.component);
  const ssrResult = await tryRenderSsr(page, options);
  const headElements = (ssrResult?.head ?? []).map(normalizeHeadElement);
  const hasCustomTitle = headElements.some((element) =>
    /<title\b[^>]*>/iu.test(element)
  );
  const headSegments = [
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    hasCustomTitle ? "" : `<title>${title}</title>`,
    headMarkup ?? "",
    // Both must precede the stylesheet links: they exist to settle the first
    // paint before the app's own CSS arrives.
    criticalCss ? `<style id="guren-critical">${criticalCss}</style>` : "",
    prepaintScript ? `<script>${prepaintScript}</script>` : "",
    stylesheetLinks,
    ...headElements,
    Object.keys(importMapEntries).length > 0
      ? `<script type="importmap">${importMap}</script>`
      : "",
    `<script>window.__INERTIA_PAGE__ = ${serializedPage};</script>`,
  ].filter((segment) => segment && segment.length > 0);
  // Inertia v3 contract: the initial page ships in a JSON script element and
  // the container div stays empty. serializePage escapes `<`, so </script>
  // breakout is safe.
  const appMarkup =
    ssrResult?.body ??
    `<script data-page="app" type="application/json">${serializedPage}</script><div id="app"></div>`;
  const bodyClass = resolveDocumentValue("bodyClass", options, page.component);
  const bodyAttributes = bodyClass ? ` class="${escapeAttribute(bodyClass)}"` : "";
  const lang = escapeAttribute(options.lang ?? "en");

  return `<!DOCTYPE html>
<html lang="${lang}">
  <head>
    ${headSegments.join("\n    ")}
  </head>
  <body${bodyAttributes}>
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
    defaultSsrRenderer ??
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

/**
 * An absolute http(s) entry means an asset dev server (Vite) is serving the
 * module graph; a same-origin path means source files are served directly,
 * where the raw stylesheet link is the only styling.
 */
function isDevServerEntry(entry: string): boolean {
  return /^https?:\/\//iu.test(entry);
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

/** One document field: per-response override, then app-wide default, then "". */
function resolveDocumentValue(
  key: keyof InertiaDocumentOptions,
  options: InertiaOptions,
  componentName: string
): string {
  const override = options[key];

  if (override !== undefined) {
    return override;
  }

  const value = documentOptions?.[key];

  return (
    (typeof value === "function" ? value({ component: componentName }) : value) ??
    ""
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
