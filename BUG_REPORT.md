# Bug Report

## Reported issue

> "Some users appear to be able to modify tasks belonging to projects they
> are not members of."

## Verdict: confirmed

## Root cause

`PATCH /tasks/:taskId/status` had no authorization check whatsoever.

```ts
// tasks.controller.ts (before)
@Patch('tasks/:taskId/status')
updateStatus(
  @Param('taskId') taskId: string,
  @Body() dto: UpdateTaskStatusDto,
): Promise<TaskDetail> {
  return this.tasksService.updateStatus(toObjectId(taskId, 'task id'), dto);
}

// tasks.service.ts (before)
async updateStatus(taskId: Types.ObjectId, dto: UpdateTaskStatusDto): Promise<TaskDetail> {
  const task = await this.findTaskOrFail(taskId);
  task.status = dto.status;
  await task.save();
  return this.toDetail(task);
}
```

Every other task-mutating endpoint (`update`, `remove`, and now `assign`)
resolves the acting user and calls `ProjectAccessService.assertCanView` or
`assertCanManage` before touching the document. This one didn't call
`ProjectAccessService` at all, and didn't even read `@CurrentUser`. The only
gate a caller had to clear was `JwtAuthGuard` — i.e. "is this a logged-in
user," not "does this user have anything to do with this project." Any
authenticated account, including one with zero organization or project
membership, could `PATCH` any task's status by guessing/enumerating a task
ID.

It's the kind of bug that's easy to introduce and easy to miss in review:
the handler compiles, the happy path works in manual testing (you're
usually testing as a user who *does* have access), and nothing in the
route's shape hints that the guard is missing — `/status` looks like a
narrower, less consequential sibling of `PATCH /tasks/:taskId`, which does
have the check.

## Impact

Any authenticated user, regardless of organization or project membership,
could change the `status` of any task in any project — moving it across
the board (e.g. `DONE` → `TODO`), including tasks in projects/organizations
they have no relationship to at all. Title, description, priority, and
deletion were unaffected (those endpoints already checked access
correctly); only the status field was exposed.

## Reproduction

Covered by `apps/api/test/task-security.e2e.spec.ts`, which:

1. Creates an organization with an owner and one project member.
2. Registers a third user (`outsider`) with no organization or project
   membership at all.
3. Has `outsider` call `PATCH /tasks/:taskId/status` on a task in that
   project.

Before the fix this returned `200` and moved the task. Confirmed by
running the same request shape manually against the dev server pre-fix
(status update succeeded with an authenticated-but-unrelated user's
token).

## Fix

`updateStatus` now takes the acting user's ID and calls
`ProjectAccessService.assertCanView` before writing, exactly like
`update()`, `remove()`, and the new `assign()`:

```ts
async updateStatus(
  taskId: Types.ObjectId,
  userId: Types.ObjectId,
  dto: UpdateTaskStatusDto,
): Promise<TaskDetail> {
  const task = await this.findTaskOrFail(taskId);
  const { project } = await this.projectAccessService.assertCanView(task.projectId, userId);
  task.status = dto.status;
  await task.save();
  return this.toDetail(task, project);
}
```

**Decision: `assertCanView`, not `assertCanManage`.** Status changes are
how the board works day to day — any project member drags a card across a
column, not just managers. `update()` additionally allows the task's
creator regardless of role, which doesn't apply here since status isn't
creator-specific. `assertCanView` is the same bar `findByProject` and
`findOne` already use, so a user who can see the board can move cards on
it, and a user who can't see the project can't touch it either way. This
is a judgment call, not something the brief specifies explicitly — flagging
it here rather than leaving it implicit.

## Regression prevention

- `apps/api/test/task-security.e2e.spec.ts` asserts a `403` for an
  outsider, a `401` for an unauthenticated request, and a `200` for a
  genuine project member — pinning both the fix and the intended
  authorization level.
- The fix follows the same `assertCanView`/`assertCanManage` pattern used
  everywhere else in the codebase rather than a one-off check, so a future
  reviewer scanning `tasks.service.ts` sees one consistent shape across
  every mutating method instead of an outlier to puzzle over.
