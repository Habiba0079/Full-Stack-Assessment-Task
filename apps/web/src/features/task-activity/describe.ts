import type { TaskActivityEntry } from '@projectflow/shared';

/**
 * Turns a raw activity record into the plain-history sentence the brief
 * asks for ("Ammar assigned Magd", "Magd changed the assignee from
 * themselves to Ahmed", "Ahmed removed the assignee") instead of exposing
 * the raw type/metadata envelope.
 */
export function describeTaskActivity(entry: TaskActivityEntry): string {
  const { actor, metadata } = entry;
  const label = (user: TaskActivityEntry['metadata']['from']): string | null => {
    if (!user) {
      return null;
    }
    return user.id === actor.id ? 'themselves' : user.name;
  };

  const from = label(metadata.from);
  const to = label(metadata.to);

  if (!from && to) {
    return `${actor.name} assigned ${to}`;
  }
  if (from && !to) {
    return `${actor.name} removed the assignee`;
  }
  if (from && to) {
    return `${actor.name} changed the assignee from ${from} to ${to}`;
  }
  return `${actor.name} updated the assignee`;
}
