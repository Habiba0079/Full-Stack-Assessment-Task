import { IsMongoId, ValidateIf } from 'class-validator';

/**
 * `assigneeId: string` assigns, `assigneeId: null` unassigns. The field is
 * required (not `@IsOptional()`) so a client cannot accidentally PATCH an
 * empty body and leave the assignee untouched — every call is explicit.
 */
export class AssignTaskDto {
  @ValidateIf((dto: AssignTaskDto) => dto.assigneeId !== null)
  @IsMongoId()
  assigneeId: string | null;
}
