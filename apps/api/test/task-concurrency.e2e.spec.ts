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
  registerUser,
  type TestUser,
} from './utils/fixtures';

/**
 * Regression coverage for the "two tasks created at the same time get the
 * same number" bug. See ASSESSMENT_NOTES.md ("Concurrent Task Creation")
 * for why `findOneAndUpdate({ $inc })` is safe here and `countDocuments`
 * + 1 wasn't.
 */
describe('Concurrent task creation', () => {
  let app: INestApplication;
  let connection: Connection;

  let owner: TestUser;
  let projectId: string;

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(connection);

    owner = await registerUser(app, 'Ammar Yaser', 'ammar@example.com');
    const organizationId = await createOrganization(
      connection,
      'Acme Software',
      'acme-software',
      owner.id,
    );
    await addOrganizationMember(connection, organizationId, owner.id, OrganizationRole.OWNER);
    projectId = await createProject(connection, organizationId, 'Internal Platform', 'ENG', owner.id);
    await addProjectMember(connection, projectId, owner.id, ProjectRole.PROJECT_MANAGER);
  });

  it('hands out a unique, gap-free number to every concurrent creation', async () => {
    const CONCURRENT_REQUESTS = 20;

    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, (_, index) =>
        request(app.getHttpServer())
          .post(`/projects/${projectId}/tasks`)
          .set('Authorization', authHeader(owner))
          .send({ title: `Concurrent task ${index}` })
          .expect(201),
      ),
    );

    const numbers = responses.map((response) => response.body.number as number).sort((a, b) => a - b);
    const keys = new Set(responses.map((response) => response.body.key as string));

    expect(keys.size).toBe(CONCURRENT_REQUESTS);
    expect(numbers).toEqual(Array.from({ length: CONCURRENT_REQUESTS }, (_, index) => index + 1));
  });
});
