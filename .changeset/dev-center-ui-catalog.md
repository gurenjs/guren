---
'@guren/cli': minor
'@guren/server': minor
---

The Dev Center gains a component catalog at `/_guren/ui` (RFC 0036 Future Work). It lists the components `guren add ui` copies into `resources/js/components/ui/` and says whether each copy matches the template the installed CLI ships, is an unedited copy of an earlier release, has been edited, or is missing, judged by the same template hashes `guren upgrade` and the `guren-ui-components` doctor check use. Below the list it frames a preview the app's Vite dev server serves at `/__guren/ui-catalog`, through `routeTypesPlugin()` from `@guren/cli/vite`, which renders every copy with the app's own Tailwind build and stylesheet in each variant and state the shipped props allow. The server mounts `/_guren/ui` and `/_guren/ui.json` behind the same `GUREN_MCP=1` opt-in and loopback guard as the rest of the Dev Center.
