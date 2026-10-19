import { ApiPropertyOptional } from '@nestjs/swagger';
import { Allow, IsOptional, IsString, MaxLength } from 'class-validator';

export class AuthLoginBodyDto {
  @ApiPropertyOptional() @Allow() usuario?: unknown;
  @ApiPropertyOptional() @Allow() senha?: unknown;
  @ApiPropertyOptional() @Allow() de?: unknown;
  @ApiPropertyOptional() @Allow() turnstileToken?: unknown;
}

export class AuthQueryDto {
  @ApiPropertyOptional() @Allow() de?: unknown;
  @ApiPropertyOptional() @Allow() code?: unknown;
  @ApiPropertyOptional() @Allow() state?: unknown;
  @ApiPropertyOptional() @Allow() error?: unknown;
}

/** Keycloak's standard authorization-code callback metadata; unknown query keys stay forbidden. */
export class AuthCallbackQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4096) code?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(512) state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128) error?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1024) error_description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2048) error_uri?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(512) session_state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2048) iss?: string;
}
