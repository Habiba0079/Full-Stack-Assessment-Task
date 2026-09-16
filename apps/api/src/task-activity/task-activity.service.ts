import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Paginated, TaskActivityEntry, UserSummary } from '@projectflow/shared';
import type { PaginationQueryDto } from '../common/dto/pagination.dto';
import { toUserSummary } from '../common/utils/serialize';
import { ProjectAccessService } from '../projects/project-access.service';
import { TasksService } from '../tasks/tasks.service';
import { UsersService } from '../users/users.service';
import { TaskActivity, type TaskActivityDocument } from './schemas/task-activity.schema';

@Injectable()
export class TaskActivityService {
  constructor(
    @InjectModel(TaskActivity.name) private readonly taskActivityModel: Model<TaskActivityDocument>,
    private readonly tasksService: TasksService,
    private readonly projectAccessService: ProjectAccessService,
    private readonly usersService: UsersService,
  ) {}

  async findByTask(
    taskId: Types.ObjectId,
    userId: Types.ObjectId,
    query: PaginationQueryDto,
  ): Promise<Paginated<TaskActivityEntry>> {
    const task = await this.tasksService.findTaskOrFail(taskId);
    await this.projectAccessService.assertCanView(task.projectId, userId);

    // Newest first, satisfied by the { taskId: 1, createdAt: -1 } index —
    // no in-memory sort needed even as the collection grows.
    const [entries, total] = await Promise.all([
      this.taskActivityModel
        .find({ taskId })
        .sort({ createdAt: -1 })
        .skip(query.skip)
        .limit(query.pageSize)
        .exec(),
      this.taskActivityModel.countDocuments({ taskId }),
    ]);

    return {
      items: await this.toEntries(entries),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * Resolves every actor and every `from`/`to` user for a page of activity
   * in one batched lookup, rather than one query per record (the brief's
   * "no obvious N+1" requirement).
   */
  private async toEntries(entries: TaskActivityDocument[]): Promise<TaskActivityEntry[]> {
    if (entries.length === 0) {
      return [];
    }

    const userIds = new Map<string, Types.ObjectId>();
    for (const entry of entries) {
      userIds.set(entry.actorId.toString(), entry.actorId);
      if (entry.metadata.from) {
        userIds.set(entry.metadata.from.toString(), entry.metadata.from);
      }
      if (entry.metadata.to) {
        userIds.set(entry.metadata.to.toString(), entry.metadata.to);
      }
    }

    const users = await this.usersService.findManyByIds(Array.from(userIds.values()));
    const usersById = new Map(users.map((user) => [user._id.toString(), toUserSummary(user)]));

    const resolve = (id: Types.ObjectId | null): UserSummary | null =>
      id ? (usersById.get(id.toString()) ?? DELETED_USER) : null;

    return entries.map((entry) => ({
      id: entry._id.toString(),
      taskId: entry.taskId.toString(),
      type: entry.type,
      actor: resolve(entry.actorId) ?? DELETED_USER,
      metadata: {
        from: resolve(entry.metadata.from),
        to: resolve(entry.metadata.to),
      },
      createdAt: entry.createdAt.toISOString(),
    }));
  }
}

const DELETED_USER: UserSummary = {
  id: '',
  name: 'Unknown user',
  email: '',
  avatarUrl: null,
};
