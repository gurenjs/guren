---
'@guren/cli': patch
---

Read the entity of a task-named acceptance id. A plan names each behaviour after its task (`AC-meetups-host-1`), and the docs graph took everything before the last dash as the entity, so no such id reached `Meetup`: `guren docs:graph --entity Meetup` and the docs viewer missed its tests. The entity is now the documented one whose class or collection name the id leads with, the longest winning, so `docs:graph --json` gains `verifies` edges from those tests to their entity. `check --docs` groups its "a test no document cites" warning by the same entity, so it now also warns on an uncited test of another task of an entity whose documents cite some of its behaviours.
