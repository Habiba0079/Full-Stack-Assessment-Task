import type { INestApplication } from '@nestjs/common';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { OrganizationRole, ProjectRole } from '@projectflow/shared';
import { createTestApp, resetDatabase } from './utils/test-app';
import {
  addOrganizationMember,
  addProjectMember,
  authHeader,
  createOrganization,
  createProject,
  createTask,
  registerUser,
  type TestUser,
} from './utils/fixtures';

describe('Task assignment', () => {
  let app: INestApplication;
  let connection: Connection;

  let owner: TestUser;
  let manager: TestUser;
  let member: TestUser;
  let otherMember: TestUser;
  let outsider: TestUser;
  let projectId: string;
  let taskId: string;

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(connection);

    owner = await registerUser(app, 'Ammar Yaser', 'ammar@example.com');
    manager = await registerUser(app, 'Sarah Ahmed', 'sarah@example.com');
    member = await registerUser(app, 'Magd Ali', 'magd@example.com');
    otherMember = await registerUser(app, 'Ahmed Hassan', 'ahmed@example.com');
    outsider = await registerUser(app, 'Outside User', 'outside@example.com');

    const organizationId = await createOrganization(
      connection,
      'Acme Software',
      'acme-software',
      owner.id,
    );
    await addOrganizationMember(connection, organizationId, owner.id, OrganizationRole.OWNER);
    await addOrganizationMember(connection, organizationId, manager.id, OrganizationRole.MEMBER);
    await addOrganizationMember(connection, organizationId, member.id, OrganizationRole.MEMBER);
    await addOrganizationMember(connection, organizationId, otherMember.id, OrganizationRole.MEMBER);

    projectId = await createProject(connection, organizationId, 'Internal Platform', 'ENG', owner.id);
    await addProjectMember(connection, projectId, manager.id, ProjectRole.PROJECT_MANAGER);
    await addProjectMember(connection, projectId, member.id, ProjectRole.MEMBER);
    await addProjectMember(connection, projectId, otherMember.id, ProjectRole.MEMBER);

    taskId = await createTask(connection, projectId, 'ENG', 1, 'Ship the thing', owner.id);
  });

  it('lets a regular member assign a task to themselves', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assignee`)
      .set('Authorization', authHeader(member))
      .send({ assigneeId: member.id })
      .expect(200);

    expect(response.body.assignee).toMatchObject({ id: member.id });
  });

  it('lets a project manager assign another project member', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assignee`)
      .set('Authorization', authHeader(manager))
      .send({ assigneeId: member.id })
      .expect(200);

    expect(response.body.assignee).toMatchObject({ id: member.id });
  });

  it('lets an organization owner assign a project member', async () => {
    await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assignee`)
      .set('Authorization', authHeader(owner))
      .send({ assigneeId: member.id })
      .expect(200);
  });

  it('refuses a regular member assigning someone other than themselves', async () => {
    await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assignee`)
      .set('Authorization', authHeader(member))
      .send({ assigneeId: otherMember.id })
      .expect(403);
  });

  it('refuses to assign a task to a user outside the project', async () => {
    await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assignee`)
      .set('Authorization', authHeader(manager))
      .send({ assigneeId: outsider.id })
      .expect(400);
  });

  it('refuses an outsider from touching the assignment at all', async () => {
    await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assignee`)
      .set('Authorization', authHeader(outsider))
      .send({ assigneeId: outsider.id })
      .expect(403);
  });

  it('lets a project manager unassign a task', async () => {
    await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assignee`)
      .set('Authorization', authHeader(manager))
      .send({ assigneeId: member.id })
      .expect(200);

    const response = await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assignee`)
      .set('Authorization', authHeader(manager))
      .send({ assigneeId: null })
      .expect(200);

    expect(response.body.assignee).toBeNull();
  });

  it('refuses a regular member unassigning someone else', async () => {
    await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assignee`)
      .set('Authorization', authHeader(manager))
      .send({ assigneeId: otherMember.id })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assignee`)
      .set('Authorization', authHeader(member))
      .send({ assigneeId: null })
      .expect(403);
  });

  it('lets a member unassign their own assignment', async () => {
    await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assignee`)
      .set('Authorization', authHeader(member))
      .send({ assigneeId: member.id })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/assignee`)
      .set('Authorization', authHeader(member))
      .send({ assigneeId: null })
      .expect(200);
  });

  describe('activity history', () => {
    it('records an activity entry for an assignment change', async () => {
      await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/assignee`)
        .set('Authorization', authHeader(manager))
        .send({ assigneeId: member.id })
        .expect(200);

      const response = await request(app.getHttpServer())
        .get(`/tasks/${taskId}/activity`)
        .set('Authorization', authHeader(manager))
        .expect(200);

      expect(response.body.total).toBe(1);
      expect(response.body.items[0]).toMatchObject({
        type: 'TASK_ASSIGNEE_CHANGED',
        actor: { id: manager.id },
        metadata: { from: null, to: { id: member.id } },
      });
    });

    it('records unassignment with a null "to"', async () => {
      await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/assignee`)
        .set('Authorization', authHeader(manager))
        .send({ assigneeId: member.id })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/assignee`)
        .set('Authorization', authHeader(manager))
        .send({ assigneeId: null })
        .expect(200);

      const response = await request(app.getHttpServer())
        .get(`/tasks/${taskId}/activity`)
        .set('Authorization', authHeader(manager))
        .expect(200);

      expect(response.body.total).toBe(2);
      // Newest first.
      expect(response.body.items[0].metadata).toMatchObject({
        from: { id: member.id },
        to: null,
      });
    });

    it('does not record a no-op assignment', async () => {
      await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/assignee`)
        .set('Authorization', authHeader(member))
        .send({ assigneeId: member.id })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/assignee`)
        .set('Authorization', authHeader(member))
        .send({ assigneeId: member.id })
        .expect(200);

      const response = await request(app.getHttpServer())
        .get(`/tasks/${taskId}/activity`)
        .set('Authorization', authHeader(member))
        .expect(200);

      expect(response.body.total).toBe(1);
    });

    it('refuses activity access to a user outside the project', async () => {
      await request(app.getHttpServer())
        .get(`/tasks/${taskId}/activity`)
        .set('Authorization', authHeader(outsider))
        .expect(403);
    });
  });
});
