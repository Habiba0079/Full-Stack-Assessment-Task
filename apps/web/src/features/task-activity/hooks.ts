'use client';

import { useQuery } from '@tanstack/react-query';
import type { Paginated, TaskActivityEntry } from '@projectflow/shared';
import { queryKeys } from '@/lib/query-keys';
import { fetchTaskActivity } from './api';

export function useTaskActivity(taskId: string) {
  return useQuery<Paginated<TaskActivityEntry>>({
    queryKey: queryKeys.taskActivity(taskId),
    queryFn: () => fetchTaskActivity(taskId),
    enabled: taskId.length > 0,
  });
}
