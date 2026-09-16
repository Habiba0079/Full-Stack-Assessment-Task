import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type FilterQuery, Model, Types } from 'mongoose';
import { TaskActivityType, type Paginated, type TaskDetail, type TaskSummary } from '@projectflow/shared';
import { toUserSummary } from '../common/utils/serialize';
import { Comment, type CommentDocument } from '../comments/schemas/comment.schema';
import { canManage, canView, ProjectAccessService } from '../projects/project-access.service';
import { Project, type ProjectDocument } from '../projects/schemas/project.schema';
import { TaskActivity, type TaskActivityDocument } from '../task-activity/schemas/task-activity.schema';
import { UsersService } from '../users/users.service';
import type { AssignTaskDto } from './dto/assign-task.dto';
import type { CreateTaskDto } from './dto/create-task.dto';
import type { ListTasksQueryDto } from './dto/list-tasks.dto';
import type { UpdateTaskDto } from './dto/update-task.dto';
import type { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { TaskCounter, type TaskCounterDocument } from './schemas/task-counter.schema';
import { Task, type TaskDocument } from './schemas/task.schema';

@Injectable()
export class TasksService {
  constructor(
    @InjectModel(Task.name) private readonly taskModel: Model<TaskDocument>,
    @InjectModel(Project.name) private readonly projectModel: Model<ProjectDocument>,
    @InjectModel(Comment.name) private readonly commentModel: Model<CommentDocument>,
    @InjectModel(TaskActivity.name) private readonly taskActivityModel: Model<TaskActivityDocument>,
    @InjectModel(TaskCounter.name) private readonly taskCounterModel: Model<TaskCounterDocument>,
    private readonly projectAccessService: ProjectAccessService,
    private readonly usersService: UsersService,
  ) {}

  async findByProject(
    projectId: Types.ObjectId,
    userId: Types.ObjectId,
    query: ListTasksQueryDto,
  ): Promise<Paginated<TaskSummary>> {
    await this.projectAccessService.assertCanView(projectId, userId);

    const filter: FilterQuery<TaskDocument> = { projectId };
    if (query.status) {
      filter.status = query.status;
    }
    if (query.priority) {
      filter.priority = query.priority;
    }

    const [tasks, total] = await Promise.all([
      this.taskModel.find(filter).sort({ number: 1 }).skip(query.skip).limit(query.pageSize).exec(),
      this.taskModel.countDocuments(filter),
    ]);

    return {
      items: await this.toSummaries(tasks),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async create(
    projectId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: CreateTaskDto,
  ): Promise<TaskDetail> {
    const { project } = await this.projectAccessService.assertCanView(projectId, userId);

    const number = await this.nextTaskNumber(projectId);

    const task = await this.taskModel.create({
      projectId,
      number,
      key: `${project.key}-${number}`,
      title: dto.title,
      description: dto.description ?? null,
      status: dto.status,
      priority: dto.priority,
      createdBy: userId,
    });

    return this.toDetail(task, project);
  }

  async findOne(taskId: Types.ObjectId, userId: Types.ObjectId): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const { project } = await this.projectAccessService.assertCanView(task.projectId, userId);

    return this.toDetail(task, project);
  }

  async update(
    taskId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: UpdateTaskDto,
  ): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const access = await this.projectAccessService.assertCanView(task.projectId, userId);

    const isCreator = task.createdBy.equals(userId);
    if (!canManage(access) && !isCreator) {
      throw new ForbiddenException('You do not have permission to edit this task');
    }

    if (dto.title !== undefined) {
      task.title = dto.title;
    }
    if (dto.description !== undefined) {
      task.description = dto.description;
    }
    if (dto.status !== undefined) {
      task.status = dto.status;
    }
    if (dto.priority !== undefined) {
      task.priority = dto.priority;
    }

    await task.save();

    return this.toDetail(task, access.project);
  }

  /**
   * `assertCanView` is the deliberate fix for the reported production bug:
   * previously this method took no `userId` at all, so any authenticated
   * user — including someone with no relationship to the project — could
   * move any task on the board. See BUG_REPORT.md.
   */
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

  /**
   * Assigns, reassigns or unassigns a task and records the transition in
   * task activity. Enforces the three rules from Part Six of the brief:
   *
   *  1. The assignee (when not null) must be able to view the project —
   *     i.e. actually be reachable as a project member.
   *  2. Only OWNER / ADMIN / PROJECT_MANAGER may assign someone other than
   *     themselves; a regular member may only assign the task to themselves.
   *  3. The same permission line governs unassignment: an elevated/PM role
   *     may clear anyone's assignment, a regular member may only clear
   *     their own.
   *
   * A no-op assignment (new value equals the current one) is accepted but
   * does not write an activity record — there is nothing to show in the
   * timeline for a change that didn't happen.
   */
  async assign(
    taskId: Types.ObjectId,
    actingUserId: Types.ObjectId,
    dto: AssignTaskDto,
  ): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const access = await this.projectAccessService.assertCanView(task.projectId, actingUserId);

    const targetAssigneeId = dto.assigneeId ? new Types.ObjectId(dto.assigneeId) : null;
    const currentAssigneeId = task.assigneeId ?? null;

    if (targetAssigneeId) {
      const isSelfAssign = targetAssigneeId.equals(actingUserId);
      if (!isSelfAssign && !canManage(access)) {
        throw new ForbiddenException(
          'You can only assign this task to yourself, not to another member',
        );
      }

      // Rule 1: the assignee must actually belong to this project. A
      // regular project row or an elevated org role both count, mirroring
      // how `assertCanView` decides who may see the project at all.
      const assigneeAccess = await this.projectAccessService.resolve(task.projectId, targetAssigneeId);
      if (!isSelfAssign && !canView(assigneeAccess)) {
        throw new BadRequestException('User is not a member of this project');
      }
    } else {
      const isSelfUnassign = currentAssigneeId?.equals(actingUserId) ?? false;
      if (!isSelfUnassign && !canManage(access)) {
        throw new ForbiddenException('You do not have permission to unassign this task');
      }
    }

    const unchanged =
      (targetAssigneeId === null && currentAssigneeId === null) ||
      (targetAssigneeId !== null && currentAssigneeId !== null && targetAssigneeId.equals(currentAssigneeId));

    if (unchanged) {
      return this.toDetail(task, access.project);
    }

    task.assigneeId = targetAssigneeId;
    await task.save();

    await this.taskActivityModel.create({
      taskId: task._id,
      type: TaskActivityType.ASSIGNEE_CHANGED,
      actorId: actingUserId,
      metadata: { from: currentAssigneeId, to: targetAssigneeId },
    });

    return this.toDetail(task, access.project);
  }

  async remove(taskId: Types.ObjectId, userId: Types.ObjectId): Promise<void> {
    const task = await this.findTaskOrFail(taskId);
    await this.projectAccessService.assertCanManage(task.projectId, userId);

    await Promise.all([
      this.commentModel.deleteMany({ taskId: task._id }),
      this.taskActivityModel.deleteMany({ taskId: task._id }),
      task.deleteOne(),
    ]);
  }

  async findTaskOrFail(taskId: Types.ObjectId): Promise<TaskDocument> {
    const task = await this.taskModel.findById(taskId).exec();
    if (!task) {
      throw new NotFoundException('Task not found');
    }
    return task;
  }

  /**
   * Hands out the next per-project task number atomically.
   *
   * The original implementation read `countDocuments` and added one in a
   * separate step, which is a classic read-then-write race: two requests
   * that both read a count of 5 will both compute 6 and create two `-6`
   * keyed tasks. `findOneAndUpdate` with `$inc` is a single atomic
   * operation on MongoDB's side — every concurrent caller gets a distinct,
   * strictly increasing value with no read/write gap for another request
   * to land in. See ASSESSMENT_NOTES.md for the fuller writeup.
   */
  private async nextTaskNumber(projectId: Types.ObjectId): Promise<number> {
    const counter = await this.taskCounterModel
      .findOneAndUpdate(
        { projectId },
        { $inc: { value: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();
    return counter.value;
  }

  private async toSummaries(tasks: TaskDocument[]): Promise<TaskSummary[]> {
    if (tasks.length === 0) {
      return [];
    }

    const assigneeIds = tasks
      .map((task) => task.assigneeId)
      .filter((id): id is Types.ObjectId => id != null);

    const [creators, assignees, commentRows] = await Promise.all([
      this.usersService.findManyByIds(tasks.map((task) => task.createdBy)),
      this.usersService.findManyByIds(assigneeIds),
      this.commentModel
        .aggregate<{
          _id: Types.ObjectId;
          count: number;
        }>([
          { $match: { taskId: { $in: tasks.map((task) => task._id) } } },
          { $group: { _id: '$taskId', count: { $sum: 1 } } },
        ])
        .exec(),
    ]);

    const creatorsById = new Map(creators.map((user) => [user._id.toString(), user]));
    const assigneesById = new Map(assignees.map((user) => [user._id.toString(), user]));
    const commentCounts = new Map(commentRows.map((row) => [row._id.toString(), row.count]));

    return tasks.map((task) => ({
      id: task._id.toString(),
      projectId: task.projectId.toString(),
      number: task.number,
      key: task.key,
      title: task.title,
      status: task.status,
      priority: task.priority,
      commentCount: commentCounts.get(task._id.toString()) ?? 0,
      createdBy: toSummaryOrDeleted(creatorsById.get(task.createdBy.toString())),
      assignee: task.assigneeId
        ? toSummaryOrDeleted(assigneesById.get(task.assigneeId.toString()))
        : null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    }));
  }

  private async toDetail(task: TaskDocument, project?: ProjectDocument): Promise<TaskDetail> {
    const [summary] = await this.toSummaries([task]);
    const resolvedProject = project ?? (await this.projectModel.findById(task.projectId).exec());

    if (!resolvedProject) {
      throw new NotFoundException('Project not found');
    }

    return {
      ...summary!,
      description: task.description ?? null,
      project: {
        id: resolvedProject._id.toString(),
        name: resolvedProject.name,
        key: resolvedProject.key,
      },
    };
  }
}

const DELETED_USER = {
  id: '',
  name: 'Unknown user',
  email: '',
  avatarUrl: null,
};

function toSummaryOrDeleted(user: Parameters<typeof toUserSummary>[0] | undefined) {
  return user ? toUserSummary(user) : DELETED_USER;
}
