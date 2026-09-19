---
"@guren/cli": patch
---

Draw a plan's flows on the `plan:render` page (RFC 0030 §3). A "Flows" tab holds
one card per flow, with the graph drawn as inline SVG from the placement
`layoutPlanFlows()` computed: a box per step with its kind, an arrow per edge with
its label, an `async` edge dashed, and an edge that closes a cycle routed in a lane
of its own under the grid. A forward edge that a box stands in the way of takes a
lane over the grid instead, and a label cut to fit keeps its whole text as the tip. A step that names a plan element links to that
element's card; a step looping to itself is reported by the checks and not drawn.
Flows print as a section, follow the "changes only" filter, and scroll inside
their card on a narrow screen. Labels are written as text and the only link a flow
produces is an in-page anchor built from a schema-validated id.
