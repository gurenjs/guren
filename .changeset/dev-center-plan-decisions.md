---
"@guren/cli": minor
---

Check the person's plan decisions from the Dev Center (RFC 0030 §8). On the plan page, a draft or an edited plan gets **Check plan:approve**, a plan with every step verified gets **Check plan:close**, and a stalled step gets **Waive an element**. Each check runs the command with `--dry-run` in a separate process under `GUREN_PLAN_DRY_RUN=1` and shows whether the command would go through, or the refusal it would print. Then it offers the command to copy into your terminal, with a waiver's reason quoted for the shell in the page. The page never runs the command. `plan:approve` and `plan:waive` gain `--dry-run`, which runs every refusal and writes nothing; a dry `plan:waive` needs no `--reason`.
