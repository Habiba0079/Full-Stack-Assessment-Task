'use client';

import { CaretDownIcon, UserCircleIcon, XIcon } from '@phosphor-icons/react/dist/ssr';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { isElevatedOrganizationRole, ProjectRole, type UserSummary } from '@projectflow/shared';
import { Avatar } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/features/auth/hooks';
import { useProject, useProjectMembers } from '@/features/projects/hooks';
import { cn } from '@/lib/utils';
import { useAssignTask } from '../hooks';

/** Above this many members, a filter box appears above the list. */
const SEARCH_THRESHOLD = 6;

interface AssigneeSelectProps {
  taskId: string;
  projectId: string;
  assignee: UserSummary | null;
}

export function AssigneeSelect({ taskId, projectId, assignee }: AssigneeSelectProps) {
  const { data: currentUser } = useCurrentUser();
  const { data: project } = useProject(projectId);
  const { data: members, isPending, isError } = useProjectMembers(projectId);
  const assignTask = useAssignTask(taskId, projectId);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);

  const canManage = useMemo(() => {
    if (!currentUser || !project) {
      return false;
    }
    const organizationRole = currentUser.organizations.find(
      (organization) => organization.id === project.organizationId,
    )?.role;
    if (isElevatedOrganizationRole(organizationRole)) {
      return true;
    }
    const ownRole = members?.find((member) => member.user.id === currentUser.id)?.role;
    return ownRole === ProjectRole.PROJECT_MANAGER;
  }, [currentUser, project, members]);

  // A regular member may only ever pick themselves, so the whole selector
  // collapses to "assign to me" / "unassign myself" instead of a list they
  // can't act on anyway — the disabled state the brief asks for, applied
  // to the choice of options rather than to greyed-out rows.
  const assignableMembers = useMemo(() => {
    if (!members) {
      return [];
    }
    if (canManage) {
      return members;
    }
    return currentUser ? members.filter((member) => member.user.id === currentUser.id) : [];
  }, [members, canManage, currentUser]);

  const visibleMembers = useMemo(() => {
    if (filter.trim().length === 0) {
      return assignableMembers;
    }
    const needle = filter.trim().toLowerCase();
    return assignableMembers.filter(
      (member) =>
        member.user.name.toLowerCase().includes(needle) ||
        member.user.email.toLowerCase().includes(needle),
    );
  }, [assignableMembers, filter]);

  const handleSelect = (user: UserSummary) => {
    setOpen(false);
    setFilter('');
    if (assignee?.id === user.id) {
      return;
    }
    assignTask.mutate(
      { assigneeId: user.id, assignee: user },
      { onError: (error) => toast.error(error.message) },
    );
  };

  const handleUnassign = () => {
    setOpen(false);
    setFilter('');
    assignTask.mutate(
      { assigneeId: null, assignee: null },
      { onError: (error) => toast.error(error.message) },
    );
  };

  if (isPending) {
    return <Skeleton className="h-8 w-full" />;
  }

  if (isError) {
    return <p className="text-[13px] text-danger">Couldn&apos;t load project members.</p>;
  }

  const canUnassign = assignee !== null && (canManage || assignee.id === currentUser?.id);
  const canOpen = assignableMembers.length > 0 || canUnassign;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setFilter('');
        }
      }}
    >
      <DropdownMenuTrigger
        disabled={assignTask.isPending || !canOpen}
        aria-label="Assignee"
        className={cn(
          'inline-flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 text-[13px] text-foreground',
          'hover:bg-surface-strong disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        {assignee ? (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar user={assignee} size="sm" />
            <span className="truncate">{assignee.name}</span>
          </span>
        ) : (
          <span className="flex items-center gap-2 text-subtle-foreground">
            <UserCircleIcon size={16} />
            Unassigned
          </span>
        )}
        <CaretDownIcon size={12} weight="bold" className="shrink-0 text-subtle-foreground" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        {assignableMembers.length > SEARCH_THRESHOLD ? (
          <div className="p-1 pb-1.5">
            <Input
              autoFocus
              placeholder="Search members…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                // Keep normal text-editing keys from being swallowed by the
                // menu's roving focus / type-ahead while still letting
                // Escape close the dropdown as expected.
                if (event.key !== 'Escape') {
                  event.stopPropagation();
                }
              }}
              className="h-8 text-[13px]"
            />
          </div>
        ) : null}

        {canUnassign ? (
          <DropdownMenuItem onSelect={handleUnassign} className="text-muted-foreground">
            <XIcon size={14} />
            Unassign
          </DropdownMenuItem>
        ) : null}

        {visibleMembers.length === 0 ? (
          <p className="px-2 py-1.5 text-[13px] text-subtle-foreground">
            {assignableMembers.length === 0 ? 'You can only assign this task to yourself.' : 'No matches.'}
          </p>
        ) : (
          visibleMembers.map((member) => (
            <DropdownMenuItem key={member.id} onSelect={() => handleSelect(member.user)}>
              <Avatar user={member.user} size="sm" />
              <span className="truncate">{member.user.name}</span>
              {assignee?.id === member.user.id ? (
                <span className="ml-auto text-[11px] text-subtle-foreground">Current</span>
              ) : null}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
