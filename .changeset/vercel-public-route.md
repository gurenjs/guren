---
'@guren/plugin-vercel': patch
---

Route the asset base back onto the output root in the emitted deployment config.

Built assets self-reference `/public/assets/`, the base the Guren Vite plugin derives, while the files themselves are copied to the output root. The emitted `config.json` carried no mapping between the two, so on a `--prebuilt` upload — routed by that file alone, and the flow the deployment guide documents — every chunk the entry script imports missed the filesystem handler, fell through to the function, and came back as HTML. The page loaded and the app never started.

Deployments built by Vercel itself were unaffected, since `vercel.json`'s `rewrites` are compiled into routing on that path. That is why the failure stayed hidden.
