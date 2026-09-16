import type { Paginated, TaskActivityEntry } from '@projectflow/shared';
import { apiRequest } from '@/lib/api-client';

const ACTIVITY_PAGE_SIZE = 50;

export function fetchTaskActivity(taskId: string): Promise<Paginated<TaskActivityEntry>> {
  return apiRequest<Paginated<TaskActivityEntry>>(`/tasks/${taskId}/activity`, {
    query: { page: 1, pageSize: ACTIVITY_PAGE_SIZE },
  });
}
