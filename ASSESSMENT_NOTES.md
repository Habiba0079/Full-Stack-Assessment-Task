# Assessment Notes

## Architecture

**Major modules.** The API is a NestJS monorepo app organized into modules for each major entity: `auth`, `users`, `organizations`, `organization-members`, `projects`, `project-members`, `tasks`, `comments`, and now `task-activity`. Each follows the same end-to-end shape — controller → service → Mongoose model, with DTOs validating input at the request boundary. This makes the codebase predictable to extend: adding task assignment followed the same structure rather than introducing a new pattern. `common/` contains cross-cutting pieces such as the JWT guard, `@CurrentUser` / `@Public` decorators, the global exception filter, `toObjectId`, `toUserSummary`, and pagination DTOs, which are reused instead of reimplemented by individual modules.

**Where business logic lives.** Business logic belongs in services rather than controllers. Controllers are intentionally thin: they parse route/query parameters into `ObjectId`s and DTOs and delegate to services. The main exception discovered during this assessment was the status-update authorization bug: `updateStatus` did not receive the current user at the controller boundary, so it could not perform the same project-access check used by the other task mutations. This is documented in `BUG_REPORT.md`.

**Frontend ↔ backend / server state.** The Next.js App Router frontend talks to the API through a single `apiRequest` wrapper (`lib/api-client.ts`) that owns the base URL, bearer token handling, and error-shape parsing. Each feature's `api.ts` therefore remains a thin collection of typed endpoint calls. Server state is managed by TanStack Query, while `lib/query-keys.ts` acts as the central registry for cache keys so mutation invalidation stays consistent across features. Local UI state such as dropdown visibility and filter text remains in React state rather than being mixed into the query cache.

**Development environment and Windows compatibility.** The starter project's web development script relied on Unix-style environment-variable expansion for `WEB_PORT`, which did not work correctly when running the monorepo on Windows. This initially prevented the web development server from starting as intended. I updated the web `dev` script to use a Windows-compatible command while preserving the configured port (`3742`). After the change, `pnpm dev` successfully started both the API and web applications on Windows. The change was intentionally kept small and isolated to the development script rather than introducing an additional cross-platform dependency solely for this issue.

**Authentication and authorization.** Authentication uses JWT bearer tokens. `JwtAuthGuard` is registered globally through `APP_GUARD`, so every route requires a valid token unless explicitly marked `@Public()`. Authorization is centralized through `ProjectAccessService`: `resolve()` checks both the caller's organization role and their project-membership row, `assertCanView` allows access when either the elevated organization role (`OWNER` / `ADMIN`) or a project-membership row grants it, and `assertCanManage` additionally requires `PROJECT_MANAGER` or an elevated organization role. Mutating task, comment, and project-member operations are expected to route through these access checks. The status-update bug was an isolated case where this convention had been skipped.

**How the main entities relate.**

```text
User
Organization ── OrganizationMember ── User   (OWNER | ADMIN | MEMBER)
Organization ── Project
Project      ── ProjectMember      ── User   (PROJECT_MANAGER | MEMBER)
Project      ── Task ── Comment
Task         ── TaskActivity                  (new: assignee-change log)
Task ── assigneeId → User                     (new: nullable, distinct from createdBy)
```

Membership is stored in separate collections at both organization and project level rather than as embedded arrays on the parent documents. This keeps membership directly queryable and indexable, with unique compound indexes on the relevant foreign keys. Tasks are numbered per project using a human-readable key derived from the project key (`ENG-1`, `WEB-3`). That numbering is now backed by a dedicated `TaskCounter` collection whose value is incremented atomically, rather than relying on `countDocuments() + 1`.

## Observations — risks and weaknesses

1. **No refresh tokens; access tokens are long-lived (`JWT_EXPIRES_IN` defaults to `7d`) with no revocation path.** If a token leaks, it remains valid until expiry unless `JWT_SECRET` is rotated, which would invalidate all active sessions rather than only the compromised one. *Would fix later* — this is a real security gap, but adding refresh tokens or token revocation would expand the scope of the assessment beyond the requested feature work. It is better to document the trade-off explicitly than to introduce a partially designed authentication flow under time pressure.

2. **`ProjectAccessService.resolve()` performs two separate lookups (organization role and project role) on each access check, and there is no request-scoped memoization.** A single task-read operation can therefore perform multiple authorization queries before the actual task data is returned. Current list endpoints generally resolve access once, so this is not yet a demonstrated bottleneck, but repeated access checks across a growing number of endpoints could create unnecessary database traffic. *Would fix later* with request-scoped memoization or a carefully designed authorization context.

3. **The status-update authorization bug shows that authorization is partly enforced by convention.** A future handler could theoretically be added without requiring the current user at the controller boundary or without calling `ProjectAccessService`, and the type system would not prevent that mistake. The assessment fix addresses the specific vulnerable endpoint and adds regression coverage. A broader structural solution would be a route-level guard/decorator pattern or another mechanism that makes the required access check harder to omit. That was intentionally kept outside the scope of this assessment because the immediate requirement was to diagnose and fix the existing vulnerability safely.

4. **Task numbering was concurrency-unsafe** because the original implementation used `countDocuments() + 1`. This has been fixed as part of the assessment using an atomic `TaskCounter` update. The reasoning and regression coverage are described in the "Concurrent Task Creation" section and in the automated tests.

## Code Review

As part of the assessment, I reviewed the original task-assignment implementation as if it were a submitted pull request:

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

**Correctness / business rules.** `userId` (the actor) is accepted but never used. There is no verification that the assignee belongs to the task's project, no validation of the caller's permission to assign, and no explicit handling of unassignment. As written, an authenticated caller could assign a task to an unrelated user.

**Security / authorization.** The function has no call to `ProjectAccessService` or an equivalent authorization layer. This is the same class of issue as the production status-update bug: the mutation changes project data without proving that the actor has permission to do so. The correct implementation therefore needs actor-level access resolution and project-membership checks before changing the task.

**Data consistency.** The original implementation does not write a `TaskActivity` record, so assignment changes are invisible to the activity history. It also does not model unassignment explicitly because `assigneeId` is treated as a required string rather than an optional/null value.

**Error handling.** Both `NotFoundException()` calls omit a message, which makes failures less descriptive than the rest of the codebase, where helper methods such as `findTaskOrFail` provide contextual errors.

**Performance.** The original code performs the task and user lookups sequentially even though they do not depend on one another. They could be fetched concurrently with `Promise.all()` where appropriate. This is a minor optimization rather than the primary correctness issue.

**Maintainability / architecture.** The original code writes `task.assignee`, while the assessment implementation uses `assigneeId` consistently with the task schema and the rest of the data model. This mismatch is a concrete indication that the function was written against an assumed schema rather than the actual one.

**What I would ask the engineer to change:** resolve the actor's project access, validate that the selected assignee is a project member, enforce the assignment permission rules, support `assigneeId: string | null` for unassignment, create an activity record for every actual assignee transition, use the schema's `assigneeId` field, provide meaningful not-found errors, and parallelize independent lookups where useful. The final implementation in `TasksService.assign()` applies these rules.

## Scaling the Activity System

Assume the system grows from roughly 5,000 to 500,000 users and task activity becomes one of the largest datasets.

**Indexes.** The current `{ taskId: 1, createdAt: -1 }` compound index is appropriate for the primary access pattern: retrieving one task's activity history newest-first. It keeps the existing per-task pagination as an index-supported query rather than a collection scan. If the product later adds cross-task activity feeds, those endpoints would need indexes for their actual access patterns, such as `{ actorId: 1, createdAt: -1 }` or a `{ projectId: 1, createdAt: -1 }` index if `projectId` is denormalized onto the activity document. I would not add these speculatively because every additional index increases write cost.

**Query patterns.** The current read pattern is "recent activity for one task." That remains relatively cheap because the activity history for a single task is expected to be small compared with the total collection size. The larger risk is introducing a cross-project or organization-wide activity feed without designing the corresponding query path first. Such a feature would need either an appropriately indexed denormalized representation or a dedicated reporting/read model.

**Cursor vs. offset pagination.** The current `skip` / `limit` pagination is reasonable for a per-task timeline because a single task should not accumulate an enormous number of activity records. A cross-task feed at very high volume would be different: large `skip` values become increasingly expensive because the database must walk past skipped documents. For that use case, I would switch to cursor-based pagination using a stable `(createdAt, _id)` cursor so the next page becomes an indexed range query.

**Archiving.** A single task's history is naturally bounded in practical terms, but the total activity collection can still grow substantially at 500,000 users. For closed or archived projects, activity older than a product-defined retention window (for example, 12–18 months) could be moved to a cold-storage collection or object storage. I would keep active-project history online because users may need to understand why a live task changed.

**Asynchronous processing / background jobs & queues.** Writing the activity record synchronously with the assignment mutation is appropriate at the current scale. It adds one small write and guarantees that a successful assignment has a corresponding history entry before the API response returns. I would introduce a queue when activity starts triggering heavier side effects such as notifications, search-index updates, analytics, or other fan-out work. The core audit record itself can remain synchronous while those secondary effects become asynchronous.

**Real-time updates.** Real-time multi-viewer updates are not implemented. TanStack Query invalidation already refreshes the acting user's own view after a mutation, which is sufficient for the current scope. If the product later requires another user watching the same task to see an assignment change immediately, SSE or WebSockets would be appropriate additions.

**Caching and observability.** At larger scale, I would first optimize measured bottlenecks rather than introducing a distributed cache or queue preemptively. `ProjectAccessService.resolve()` is one concrete candidate for request-scoped memoization because it is called repeatedly along protected request paths. For observability, practical first steps would be MongoDB slow-query logging and per-endpoint latency metrics, especially p95 latency for activity and authorization paths.

## Verification

The implementation was verified locally after the assessment changes were merged.

* `pnpm build` completed successfully across the workspace.
* `pnpm test` completed successfully with **7 test suites passed and 37 tests passed**.
* The assignment, authorization, and concurrency regression suites all passed.
* The application was started locally with `pnpm dev` on Windows, with both API and web applications running successfully.
* Manual UI verification covered task assignment, assignee changes, unassignment, and the resulting activity timeline.
* The production authorization bug was also verified manually through the API using a non-member account; the request returned `403 Forbidden` with `"You do not have access to this project"`.

## If I Had Two More Days

1. **Make project-access enforcement structural rather than convention-based.** The status bug demonstrated that a protected mutation can become unsafe when a handler forgets to perform the access check. I would introduce a stronger guard/decorator pattern or a static/lint-based check that makes missing authorization harder to introduce.

2. **Expand the automated test suite further.** The current assessment tests run successfully in a real local environment, with all 37 tests passing across seven suites. With additional time, I would broaden coverage around edge cases such as repeated assignment to the same user, repeated unassignment, invalid member transitions, and additional concurrent task-creation scenarios rather than treating the current suite as exhaustive.

3. **Add multi-viewer live updates.** An SSE or WebSocket layer could push activity and task changes to other users currently viewing the same project, removing the need for a manual refresh.

4. **Use cursor-based pagination for any future cross-task activity feed.** The existing per-task offset pagination is sufficient for the current feature. A cross-project feed at high volume would be a better fit for cursor-based pagination from the start.

5. **Add refresh tokens and session revocation.** This remains a meaningful authentication improvement because the current access tokens are long-lived and there is no per-session revocation path. It was intentionally left outside the assessment scope.
