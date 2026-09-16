'use client';

import { ClockCounterClockwiseIcon } from '@phosphor-icons/react/dist/ssr';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { describeTaskActivity } from '../describe';
import { useTaskActivity } from '../hooks';

export function ActivityTimeline({ taskId }: { taskId: string }) {
  const { data, isPending, isError, error } = useTaskActivity(taskId);

  return (
    <section className="space-y-4" aria-label="Activity">
      <h2 className="text-sm font-semibold text-foreground">Activity</h2>

      {isPending ? (
        <div className="space-y-2.5">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      ) : isError ? (
        <p className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[13px] text-danger">
          {error.message}
        </p>
      ) : data.items.length === 0 ? (
        <EmptyState
          icon={ClockCounterClockwiseIcon}
          title="No activity yet"
          description="Assignee changes for this task will show up here."
        />
      ) : (
        <ol className="space-y-2.5">
          {data.items.map((entry) => (
            <li
              key={entry.id}
              className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-2.5 last:border-none last:pb-0"
            >
              <p className="text-[13px] text-foreground">{describeTaskActivity(entry)}</p>
              <time
                dateTime={entry.createdAt}
                title={formatDateTime(entry.createdAt)}
                className="shrink-0 text-[12px] text-subtle-foreground"
              >
                {formatRelativeTime(entry.createdAt)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
