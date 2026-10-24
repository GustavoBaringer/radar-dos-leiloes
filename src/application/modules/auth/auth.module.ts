import { Module } from '@nestjs/common';
import { AuthController } from '../../controllers/auth/auth.controller.js';
import { AuthService } from '../../services/auth/auth.service.js';
import { OnboardingActivationModule } from '../onboarding-activation/onboarding-activation.module.js';

@Module({ imports: [OnboardingActivationModule], controllers: [AuthController], providers: [AuthService] })
export class AuthModule {}
