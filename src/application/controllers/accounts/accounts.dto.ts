import { ApiPropertyOptional } from '@nestjs/swagger';
import { Allow, IsOptional, IsString } from 'class-validator';

// Transport DTOs intentionally leave service-owned validation authoritative.
export class AccountPaginationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() page?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() pageSize?: string;
}

export class AccountBodyDto {
  @Allow() turnstileToken?: unknown;
  @Allow() email?: unknown;
  @Allow() nome?: unknown;
  @Allow() interesse?: unknown;
  @Allow() consentimento?: unknown;
  @Allow() documento?: unknown;
  @Allow() celular?: unknown;
  @Allow() consentimentoVersao?: unknown;
  @Allow() marketing?: unknown;
  @Allow() origem?: unknown;
  @Allow() label?: unknown;
  @Allow() q?: unknown;
  @Allow() filters?: unknown;
  @Allow() channels?: unknown;
  @Allow() lotId?: unknown;
  @Allow() alertId?: unknown;
  @Allow() endpoint?: unknown;
  @Allow() keys?: unknown;
  @Allow() expirationTime?: unknown;
}
