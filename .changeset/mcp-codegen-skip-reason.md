---
'@guren/server': patch
---

Report why the MCP codegen tool skipped an artifact

`guren_codegen` filed every empty generator result under `"nothing to generate"`.
That is right for an app with no page components, and wrong for the one case where
a generator declines on purpose: the pages manifest is not written into an app that
cannot compile one. An agent that just wrote a page component and asked for codegen
was told there was nothing to describe. Generators can now carry a sentence with the
empty result, and the tool reports it in place of the generic reason.
