'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated, TaskDetail, TaskStatus, TaskSummary, UserSummary } from '@projectflow/shared';
import { queryKeys } from '@/lib/query-keys';
import {
  assignTask,
  createTask,
  type CreateTaskPayload,
  fetchProjectTasks,
  fetchTask,
  updateTaskStatus,
} from './api';

export function useProjectTasks(projectId: string) {
  return useQuery<Paginated<TaskSummary>>({
    queryKey: queryKeys.projectTasks(projectId),
    queryFn: () => fetchProjectTasks(projectId),
    enabled: projectId.length > 0,
  });
}

export function useTask(taskId: string) {
  return useQuery<TaskDetail>({
    queryKey: queryKeys.task(taskId),
    queryFn: () => fetchTask(taskId),
    enabled: taskId.length > 0,
  });
}

export function useCreateTask(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation<TaskDetail, Error, CreateTaskPayload>({
    mutationFn: (payload) => createTask(projectId, payload),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
      ]);
    },
  });
}

export function useUpdateTaskStatus(taskId: string, projectId: string) {
  const queryClient = useQueryClient();

  return useMutation<TaskDetail, Error, TaskStatus>({
    mutationFn: (status) => updateTaskStatus(taskId, status),
    onSuccess: async (task) => {
      queryClient.setQueryData(queryKeys.task(taskId), task);
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) });
    },
  });
}

export interface AssignTaskVariables {
  /** `null` unassigns. */
  assigneeId: string | null;
  /** The full user record, so the UI can update optimistically before the server responds. */
  assignee: UserSummary | null;
}

/**
 * Optimistic update with rollback: the selector needs to feel instant (it's
 * the kind of control people click through quickly while triaging a board),
 * and the worst case if the server disagrees — a permission error, a stale
 * membership — is rare and easy to recover from by restoring the previous
 * value and surfacing the error via toast. A "loading" state on every click
 * would make a fast selector feel sluggish for no real benefit here.
 */
export function useAssignTask(taskId: string, projectId: string) {
  const queryClient = useQueryClient();

  return useMutation<TaskDetail, Error, AssignTaskVariables, { previous: TaskDetail | undefined }>({
    mutationFn: (variables) => assignTask(taskId, variables.assigneeId),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.task(taskId) });
      const previous = queryClient.getQueryData<TaskDetail>(queryKeys.task(taskId));
      if (previous) {
        queryClient.setQueryData<TaskDetail>(queryKeys.task(taskId), {
          ...previous,
          assignee: variables.assignee,
        });
      }
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.task(taskId), context.previous);
      }
    },
    onSuccess: (task) => {
      queryClient.setQueryData(queryKeys.task(taskId), task);
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.taskActivity(taskId) }),
      ]);
    },
  });
}
