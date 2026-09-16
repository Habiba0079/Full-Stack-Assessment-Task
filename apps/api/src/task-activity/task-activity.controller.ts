import { Controller, Get, Param, Query } from '@nestjs/common';
import type { Paginated, TaskActivityEntry } from '@projectflow/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination.dto';
import { toObjectId } from '../common/utils/object-id';
import { TaskActivityService } from './task-activity.service';

@Controller('tasks/:taskId/activity')
export class TaskActivityController {
  constructor(private readonly taskActivityService: TaskActivityService) {}

  @Get()
  findByTask(
    @Param('taskId') taskId: string,
    @CurrentUser('id') userId: string,
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<TaskActivityEntry>> {
    return this.taskActivityService.findByTask(
      toObjectId(taskId, 'task id'),
      toObjectId(userId, 'user id'),
      query,
    );
  }
}
