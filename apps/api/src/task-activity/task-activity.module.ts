import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TasksModule } from '../tasks/tasks.module';
import { UsersModule } from '../users/users.module';
import { TaskActivityController } from './task-activity.controller';
import { TaskActivityService } from './task-activity.service';

@Module({
  // TaskActivity's schema is registered by TasksModule (it needs the model
  // too, to write activity rows on assignment) and re-exported here via
  // TasksModule's `exports: [..., MongooseModule]`.
  imports: [TasksModule, ProjectsModule, UsersModule],
  controllers: [TaskActivityController],
  providers: [TaskActivityService],
})
export class TaskActivityModule {}
