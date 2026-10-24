import { IsOptional, IsString, MaxLength } from 'class-validator';

export class OnboardingConfirmDto {
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  token?: string;
}
