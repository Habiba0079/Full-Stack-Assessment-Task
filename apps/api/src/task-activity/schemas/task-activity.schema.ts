import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';
import { TASK_ACTIVITY_TYPES, TaskActivityType } from '@projectflow/shared';

export type TaskActivityDocument = HydratedDocument<TaskActivity>;

/**
 * An immutable log entry for a task change worth surfacing as history.
 * Only assignee changes are recorded today (see `TaskActivityType`); the
 * shape leaves room for more types without a migration.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'task_activity' })
export class TaskActivity {
  @Prop({ type: Types.ObjectId, ref: 'Task', required: true, index: true })
  taskId: Types.ObjectId;

  @Prop({ type: String, enum: TASK_ACTIVITY_TYPES, required: true })
  type: TaskActivityType;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  actorId: Types.ObjectId;

  @Prop({
    type: {
      from: { type: Types.ObjectId, ref: 'User', default: null },
      to: { type: Types.ObjectId, ref: 'User', default: null },
    },
    required: true,
    _id: false,
  })
  metadata: { from: Types.ObjectId | null; to: Types.ObjectId | null };

  createdAt: Date;
}

export const TaskActivitySchema = SchemaFactory.createForClass(TaskActivity);

// Feed is always "newest activity for this task first" — see Part Eight
// (Activity API) in the brief. A compound index lets Mongo satisfy the
// query with an index scan instead of an in-memory sort.
TaskActivitySchema.index({ taskId: 1, createdAt: -1 });
