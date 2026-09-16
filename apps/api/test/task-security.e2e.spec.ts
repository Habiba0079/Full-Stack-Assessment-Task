import type { INestApplication } from '@nestjs/common';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { OrganizationRole, ProjectRole, TaskStatus } from '@projectflow/shared';
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

/**
 * Regression coverage for the reported production bug: "some users appear
 * to be able to modify tasks belonging to projects they are not members
 * of." Root cause and fix are in BUG_REPORT.md — this file pins the fix
 * down so it can't silently regress.
 */
describe('Task status authorization (bug regression)', () => {
  let app: INestApplication;
  let connection: Connection;

  let owner: TestUser;
  let member: TestUser;
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
    member = await registerUser(app, 'Magd Ali', 'magd@example.com');
    outsider = await registerUser(app, 'Outside User', 'outside@example.com');

    const organizationId = await createOrganization(
      connection,
      'Acme Software',
      'acme-software',
      owner.id,
    );
    await addOrganizationMember(connection, organizationId, owner.id, OrganizationRole.OWNER);
    await addOrganizationMember(connection, organizationId, member.id, OrganizationRole.MEMBER);

    projectId = await createProject(connection, organizationId, 'Internal Platform', 'ENG', owner.id);
    await addProjectMember(connection, projectId, member.id, ProjectRole.MEMBER);

    taskId = await createTask(connection, projectId, 'ENG', 1, 'Ship the thing', owner.id);
  });

  it('refuses a user with no relationship to the project', async () => {
    await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/status`)
      .set('Authorization', authHeader(outsider))
      .send({ status: TaskStatus.DONE })
      .expect(403);

    const check = await request(app.getHttpServer())
      .get(`/tasks/${taskId}`)
      .set('Authorization', authHeader(owner))
      .expect(200);
    expect(check.body.status).not.toBe(TaskStatus.DONE);
  });

  it('refuses an unauthenticated request outright', async () => {
    await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/status`)
      .send({ status: TaskStatus.DONE })
      .expect(401);
  });

  it('lets a genuine project member update the status', async () => {
    await request(app.getHttpServer())
      .patch(`/tasks/${taskId}/status`)
      .set('Authorization', authHeader(member))
      .send({ status: TaskStatus.IN_PROGRESS })
      .expect(200);
  });
});
