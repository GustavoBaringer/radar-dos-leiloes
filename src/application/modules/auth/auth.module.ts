import { Module } from '@nestjs/common';
import { AuthController } from '../../controllers/auth/auth.controller.js';
import { AuthService } from '../../services/auth/auth.service.js';

@Module({ controllers: [AuthController], providers: [AuthService] })
export class AuthModule {}
