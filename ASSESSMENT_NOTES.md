# Assessment Notes

## Architecture

**Major modules.** The API is a NestJS monorepo app organized one module
per entity: `auth`, `users`, `organizations`, `organization-members`,
`projects`, `project-members`, `tasks`, `comments`, and now
`task-activity`. Each follows the same shape end to end — controller →
service → Mongoose model, DTOs validating input at the request boundary —
which makes the codebase predictable to extend: adding task assignment
meant following the same shape rather than inventing a new one. `common/`
holds cross-cutting pieces (the JWT guard, the `@CurrentUser` /
`@Public` decorators, the global exception filter, `toObjectId`,
`toUserSummary`, pagination DTOs) that every module reuses instead of
re-implementing.

**Where business logic lives.** In the services, not the controllers.
Controllers are thin — they parse route/query params into `ObjectId`s and
DTOs and hand off. The one real exception was the bug this assessment
asked to investigate: `updateStatus` had drifted to having *no*
controller-level parameter for the user at all, which is exactly why it
skipped the service-level check every other mutator has (see
`BUG_REPORT.md`).

**Frontend ↔ backend / server state.** The Next.js App Router frontend
talks to the API through a single `apiRequest` wrapper
(`lib/api-client.ts`) that owns the base URL, the bearer token, and error
shape parsing, so every feature's `api.ts` file is just a thin list of
typed endpoint calls. Server state is owned entirely by TanStack Query;
`lib/query-keys.ts` is the single registry of cache keys so invalidation
after a mutation is centralized and doesn't drift between features. Local
UI state (dropdown open/closed, a filter string) stays in React state,
never mixed into the query cache.

**Authentication and authorization.** Authentication is a JWT bearer
token; `JwtAuthGuard` is registered globally via `APP_GUARD`, so every
route requires a valid token unless explicitly marked `@Public()`.
Authorization is centralized in one place, `ProjectAccessService`:
`resolve()` looks up both the caller's organization role and their
project-membership row, `assertCanView` throws unless either grants
access (an elevated org role — `OWNER`/`ADMIN` — reaches every project in
the org; a project-member row reaches just that project), and
`assertCanManage` additionally requires `PROJECT_MANAGER` or an elevated
org role. Every mutating task/comment/project-member endpoint is supposed
to route through one of these two — the status bug was a single module
that had silently stopped doing that.

**How the main entities relate.**

```
User
Organization ── OrganizationMember ── User   (OWNER | ADMIN | MEMBER)
Organization ── Project
Project      ── ProjectMember      ── User   (PROJECT_MANAGER | MEMBER)
Project      ── Task ── Comment
Task         ── TaskActivity                  (new: assignee-change log)
Task ── assigneeId → User                      (new: nullable, distinct from createdBy)
```

Membership is its own collection on both levels rather than an array on
the parent document — indexable and queryable directly, with a unique
compound index on the two foreign keys. Tasks are numbered per project
via a human-readable key derived from the project key (`ENG-1`,
`WEB-3`); that numbering is now backed by a separate `TaskCounter`
collection incremented atomically (see "Concurrent Task Creation" below)
rather than the project document itself, so a burst of task creation
doesn't also contend with reads/writes of `Project`.

## Observations — risks and weaknesses

1. **No refresh tokens; access tokens are long-lived (`JWT_EXPIRES_IN`
   defaults to `7d`) with no revocation path.** If a token leaks, it's
   valid for up to a week with nothing short of rotating `JWT_SECRET`
   (which invalidates every session, not just the one) to shut it down.
   *Would fix later* — it's a real gap, but it's also exactly the kind of
   architectural change ("add a refresh flow / token revocation list")
   the brief explicitly asks not to take on speculatively inside a
   4–6 hour assessment. Worth flagging loudly, not worth doing here.

2. **`ProjectAccessService.resolve()` runs two separate queries
   (organization role, project role) on every single access check, and
   nothing caches the result within a request.** A single `GET /tasks/
   :taskId` triggers `findTaskOrFail` then `assertCanView`, which is two
   round trips just for authorization before the actual data is even
   touched; list endpoints that resolve access once are fine, but any
   future endpoint that calls `assertCanView` in a loop (there isn't one
   today) would be an N+1 waiting to happen. *Would fix later* — not
   costly yet at this data volume, but worth a per-request memoization
   layer if project endpoints multiply.

3. **The status-update authorization bug (this assessment's Part
   Eleven) shows the access-check pattern is a convention, not something
   the type system enforces.** Nothing stops a future controller method
   from being added without a `@CurrentUser()` param and without calling
   `ProjectAccessService`, and nothing would fail until someone noticed
   in production. *Would fix now, but out of scope for one assessment* —
   the real fix is structural (e.g. a route-level guard/decorator that
   requires an explicit access-check call to be proven, or an
   interceptor that asserts every non-`@Public()` mutating handler
   touched `ProjectAccessService`), not a one-line patch. I fixed the one
   instance found; I did not build the general enforcement mechanism.

4. **Task numbering was concurrency-unsafe** (`countDocuments` + 1) —
   already covered as one of the two required fixes; see "Concurrent Task
   Creation" below for the fix and reasoning. *Fixed now.*

## Code Review

Reviewing this as a submitted PR:

```ts
async assignTask(taskId: string, assigneeId: string, userId: string) {
  const task = await this.taskModel.findById(taskId);
  if (!task) { throw new NotFoundException(); }
  const user = await this.userModel.findById(assigneeId);
  if (!user) { throw new NotFoundException(); }
  task.assignee = user._id;
  await task.save();
  return task;
}
```

**Correctness / business rules.** `userId` (the actor) is accepted as a
parameter but never used. There's no check that `assigneeId` belongs to
the task's project, and no check on who `userId` is or whether they're
allowed to assign anyone at all — every rule from Part Six of the brief
(project membership, assign permissions, unassignment) is simply absent.
As written, any authenticated caller can assign any task to any user in
the system, including a user with no relationship to the project or the
organization.

**Security / authorization.** No call to `ProjectAccessService` (or
anything like it) anywhere in this function — it's the same shape of gap
as the reported production bug (Part Eleven), in a brand-new endpoint
this time instead of an existing one. I'd block this PR on that alone.

**Data consistency.** No activity record is written, so the change is
silent — Part Seven of the brief explicitly asks for an activity trail,
and this loses it entirely. There's also no handling for `assigneeId`
being unset/null (unassignment) — the DTO signature `assigneeId: string`
doesn't even allow it.

**Error handling.** Both `NotFoundException()` calls omit a message,
so the client (and whoever's debugging) sees a bare 404 with no
indication whether it was the task or the user that was missing —
inconsistent with the rest of the codebase, where `findTaskOrFail`
etc. always pass a message.

**Performance.** Two sequential round trips (`findById` on the task,
then `findById` on the user) where the data doesn't depend on each other
— they could run as `Promise.all([...])`. Minor at this scale, but it's
a pattern that compounds if copied elsewhere.

**Maintainability / architecture.** `task.assignee` is written directly,
but the actual schema field this assessment introduces is `assigneeId`
(consistent with `createdBy`, `projectId` elsewhere in the codebase) —
this method wouldn't even compile against the real `Task` schema. If this
were real generated code I'd flag the naming mismatch specifically, since
it suggests the function was written against an assumption about the
schema rather than the schema itself.

**What I'd ask the engineer to change:** add the actor's project-access
resolution and the three business rules from Part Six; accept
`assigneeId: string | null` and branch on unassignment; write a
`TaskActivity` row for every real transition; batch the two lookups;
give both `NotFoundException`s a message; and rename the write target to
match the actual schema field. I would not rewrite the function myself
beyond what's needed to point out *why* each change matters — see
`TasksService.assign()` in this codebase for the version I'd actually
ship.

## Scaling the Activity System

Assume 5,000 → 500,000 users and task activity becomes one of the
largest datasets in the system.

**Indexes.** The current `{ taskId: 1, createdAt: -1 }` compound index is
the right shape for "give me one task's history, newest first" and stays
correct at any scale — it's what makes the current pagination an index
scan, not a collection scan. What it doesn't serve is any cross-task
query ("everything I did last week", "recent activity across a
project"); if product ever wants those views, they need their own
indexes (e.g. `{ actorId: 1, createdAt: -1 }`, or a `{ projectId: 1,
createdAt: -1 }` if `projectId` gets denormalized onto the activity row
to avoid a join through `Task`). I would not add those speculatively
today — only once a real read pattern asks for them, since every extra
index is write-amplification on an already high-write collection.

**Query patterns.** The read path that matters at scale is "recent
activity for one task," which stays cheap (one task's history doesn't
grow past a few dozen–hundred entries even for a long-lived task,
regardless of how many users the system has). The risk is a query
pattern nobody's built yet becoming expensive by accident — e.g., an
admin "activity across the whole org" report would need to either scan
per-project or maintain its own denormalized/pre-aggregated view; I
would not build that until it's a real requirement.

**Cursor vs. offset pagination.** Today's `skip`/`limit` is fine per-task
because a single task's activity list is small and bounded. It stops
being fine the moment a *feed* spans many tasks with high total volume —
`skip(100000)` still has to walk past 100,000 documents server-side. If
a cross-task feed becomes a real feature, I'd switch that endpoint (not
necessarily the per-task one) to cursor-based pagination keyed on
`(createdAt, _id)`, which turns "seek to page 4000" into an indexed
range query instead of a skip.

**Archiving.** Per-task activity is naturally bounded and cheap to keep
forever, but the *collection* isn't — at 500k users generating routine
assignment churn, `task_activity` becomes one of the largest collections
in the system by row count even though no single document is large.
I'd move activity older than some window (e.g. 12–18 months) for
*closed/archived projects only* to cold storage (a separate collection
or object storage export), decided by product/compliance rather than
guessed at here — I wouldn't archive active-project history, since
"why was this reassigned" needs to stay queryable for as long as the
task itself is relevant.

**Asynchronous processing / background jobs & queues.** Writing the
activity row synchronously inside the same request as the assignment
change is correct today — it's one extra insert, and doing it inline
keeps the read-your-own-write guarantee (the timeline updates the moment
the mutation succeeds) with the simplest possible failure mode. I would
not move it to a queue preemptively; I'd only do that if activity
writing grew extra side effects (e.g. sending notifications, updating a
search index) heavy enough to threaten the latency of the assignment
request itself, at which point the write splits into "record activity
synchronously" (cheap, stays inline) and "fan out side effects" (moves
to a queue).

**Real-time updates.** Not built, and I wouldn't build it speculatively
either — TanStack Query's cache invalidation after a mutation already
gives the *acting* user's own browser an instant update, which covers
the common case (you assign a task, you see it change). Multi-viewer
live updates (someone else watching the same task sees your change
without a refresh) would need a push mechanism (SSE or WebSockets) and
is a legitimate "two more days" item below, but it's exactly the kind of
addition the brief warns against reaching for without a concrete driving
need.

**Caching and observability.** At 500k users the read path worth
watching isn't activity itself but `ProjectAccessService.resolve()`,
called on every single access check including every activity-feed
fetch (see Observation #2) — I'd add request-scoped memoization there
before reaching for a distributed cache. For observability, the concrete,
boring thing I'd add first is a slow-query log threshold on Mongo and a
per-endpoint p95 latency metric, so a regression in the activity feed
(or anywhere else) shows up before a user reports it — not a caching
layer or a message queue, which is exactly the "technology parade" the
brief warns against reaching for without a demonstrated need.

## If I Had Two More Days

In priority order:

1. **Turn the assignment/access-check convention into something
   enforced, not just followed.** The production bug existed because
   nothing failed when a handler skipped the authorization call. I'd add
   either a custom decorator (`@RequiresProjectAccess()`) backed by a
   guard, or a lint rule / test that asserts every non-`@Public()`
   mutating controller method in `tasks`/`comments`/`projects` has a
   corresponding `ProjectAccessService` call in its service method. This
   is first because it's the highest-leverage fix — it prevents the
   *next* version of the bug I already found, not just this one.

2. **Actually run the test suite in a real environment and iterate.**
   I wrote the assignment/activity/security/concurrency tests against
   the existing patterns and confirmed they typecheck and lint cleanly,
   but this sandbox's network allowlist blocks `fastdl.mongodb.org`, so
   `mongodb-memory-server` can't download its binary here — I could not
   execute `pnpm test` in this environment. Running it for real (and
   fixing whatever a first run inevitably surfaces — off-by-ones in the
   concurrency test's expected numbering, a fixture I got subtly wrong)
   is squarely a "two more hours," not "two more days," item, but it's
   first on the list precisely because it's cheap and currently
   unverified.

3. **Multi-viewer live updates for the activity timeline and board**
   (SSE, given the stack already leans simple — no existing WebSocket
   infrastructure to build on). Right now a second browser tab watching
   the same task doesn't see an assignment change until it refetches.
   Not urgent for a small team tool, but it's the most noticeable gap
   between this and a "real" project-management product.

4. **Cursor-based pagination for any future cross-task activity
   view**, per the scaling section above — not needed for the per-task
   feed as it exists today, but worth having ready before a "recent
   activity across my projects" feature gets built on top of `skip`.

5. **Refresh tokens / session revocation**, per Observation #1. Real
   security gap, but the lowest-frequency risk of the five for a tool
   with this current threat model (internal team tool, not
   internet-facing consumer auth), so it's last rather than absent.
