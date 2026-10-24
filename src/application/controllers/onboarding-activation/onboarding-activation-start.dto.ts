import { IsString, Matches } from 'class-validator';

export class OnboardingActivationStartDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;
}
