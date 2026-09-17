# AI Usage Log

## Tools used

Claude (Sonnet), working directly in a sandboxed dev container with the
repository cloned, full read access to the codebase, and the ability to
run `pnpm typecheck`/`pnpm lint`/`pnpm build`/`pnpm test`.

## How it was used

- **Exploration.** Read through the existing modules end to end before
  writing anything — schemas, `ProjectAccessService`, the comments
  module (as the closest existing analogue to task activity), the
  frontend's task feature (`api.ts`/`hooks.ts`/components) and its
  TanStack Query + `apiRequest` conventions, and the existing e2e test
  fixtures — specifically to copy the established patterns rather than
  introduce new ones.
- **Bug-finding.** Both required bugs (Part Eleven's status-auth gap,
  Part Twelve's task-numbering race) were located by reading
  `tasks.service.ts`/`tasks.controller.ts` directly, not by prompting
  an AI to "find bugs" — they were visible on inspection once the rest
  of the module's pattern (every other mutator calling
  `ProjectAccessService`) made `updateStatus`'s omission stand out, and
  the `count + 1` line was a known anti-pattern.
- **Implementation.** Wrote the schema, service, controller, and DTO
  changes directly, matching the existing module shape (see
  `ASSESSMENT_NOTES.md` → Architecture) rather than generating a
  divergent structure.
- **Test generation.** Wrote the e2e specs by hand against the existing
  `test/utils/fixtures.ts` and `test/utils/test-app.ts` helpers, mirroring
  `tasks.e2e.spec.ts`'s structure. Not executed in this sandbox — see
  "Generated code you modified" below.
- **Debugging / verification.** Ran `pnpm typecheck`, `pnpm lint`, and
  `pnpm build` (API) after every meaningful chunk of work rather than at
  the end, to catch mistakes immediately instead of compounding them.
- **Review.** Part Fourteen's code-review exercise in `ASSESSMENT_NOTES.md`
  was written by reading the provided snippet against the actual `Task`
  schema and `ProjectAccessService` this assessment introduces/uses — not
  generated from a generic "review this code" prompt.

## Suggestions rejected or significantly changed

- **First pass at the assignee selector used Radix `Select`, not
  `DropdownMenu`.** `Select` is the more obvious component for "pick one
  of N options," but Radix `Select`'s content isn't a good host for an
  arbitrary search `<input>` (it fights the primitive's own type-ahead
  and keyboard handling). Switched to `DropdownMenu` — already used
  elsewhere in the app — with the input's `onKeyDown` deliberately
  stopping propagation (except `Escape`) so typing isn't hijacked. This
  was a correctness fix, not a style preference: the first version would
  have shipped a search box that didn't reliably accept keystrokes.
- **Considered denormalizing `projectId` onto `TaskActivity` from the
  start** (to allow a future project-wide activity feed without joining
  through `Task`). Rejected for now — nothing in this assessment's scope
  asks for a cross-task feed, and adding a field "in case it's useful
  later" is exactly the speculative-complexity the brief warns against.
  It's called out explicitly in the scaling answer instead, as something
  to add if that requirement actually shows up.
- **Considered making the unassign permission rule "only OWNER/ADMIN/
  PROJECT_MANAGER may unassign, full stop"** (simpler than the two-line
  rule that also lets a member clear their own assignment). Changed it
  after re-reading Part Six: it says an authorized user "may remove the
  current assignee," and the natural reading — consistent with "a
  regular member may assign a task to themselves" — is that self-service
  extends to unassigning yourself too. Documented as an explicit
  assumption in `TasksService.assign()`'s doc comment rather than left
  implicit, since the brief doesn't spell this exact case out.

## Generated code that was modified

- The first draft of `TasksService.assign()` resolved the assignee's
  project access with a hand-rolled boolean check duplicating
  `ProjectAccessService`'s own `canView()` logic (string-comparing
  roles). Replaced it with the actual exported `canView()` helper once
  I noticed the duplication — same behavior, but one source of truth
  instead of two that could drift apart.
- The e2e tests were written but **could not be executed in this
  particular sandbox**: `mongodb-memory-server` needs to download a
  MongoDB binary from `fastdl.mongodb.org`, which isn't in this
  container's network allowlist. `pnpm typecheck` and `pnpm lint` both
  pass on the test files, and they were written directly against the
  project's existing, working fixture helpers rather than invented from
  scratch — but "typechecks and matches existing patterns" is not the
  same claim as "I watched it pass." This is flagged here, in
  `ASSESSMENT_NOTES.md`'s "If I Had Two More Days," and in `README.md`
  rather than glossed over. Running `pnpm test` on a machine with normal
  internet access is the first thing I'd do next.
