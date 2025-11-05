import type { Page } from "@inertiajs/core";
import { renderInertiaServer } from "@guren/inertia-client";
import type { InertiaSsrContext, InertiaSsrResult } from "@guren/server";

let pages: Record<string, () => Promise<unknown>> | undefined;

try {
  pages = import.meta.glob("./pages/**/*.tsx") as Record<
    string,
    () => Promise<unknown>
  >;
} catch {
  pages = undefined;
}

export default async function renderSsr(
  context: InertiaSsrContext
): Promise<InertiaSsrResult> {
  return renderInertiaServer({
    page: context.page as Page,
    pages,
    resolve: pages ? undefined : (name) => import(`./pages/${name}.tsx`),
  });
}
