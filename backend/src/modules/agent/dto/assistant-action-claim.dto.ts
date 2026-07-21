import { IsOptional, Matches } from 'class-validator';

/**
 * The desktop process receives the raw one-time token only after it atomically
 * claims a quote preparation. The database stores SHA-256 only.
 */
export class AssistantActionClaimTokenDto {
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  claimToken!: string;
}

export class ReleaseAssistantActionClaimDto extends AssistantActionClaimTokenDto {
  @IsOptional()
  @Matches(/^[A-Z][A-Z0-9_]{2,63}$/)
  failureCode?: string;
}
