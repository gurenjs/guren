---
'@guren/cli': minor
---

The plan review page `plan:render` writes gains a **Copy prompt for the agent** button. It copies one message, in the page's language, that names the plan file and asks the agent to apply the review with the plan-write skill, followed by the page's feedback, so the reader pastes a single prompt into the agent's session. The page also says that answering or approving on the page alone leaves the plan file unchanged. The commands the page prints now name the plan by its path from where `plan:render` ran (`docs/plans/comments/plan.json`) rather than by its file name alone, so they can be pasted as they are.
