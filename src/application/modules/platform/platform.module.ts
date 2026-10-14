import { Module } from '@nestjs/common';
import { PlatformSecurityController } from '../../controllers/platform/security.controller.js';
import { CollectionAdminController } from '../../controllers/platform/collection-admin.controller.js';
import { PlatformSecurityService } from '../../services/platform/security.service.js';
import { CollectionAdminService } from '../../services/platform/collection-admin.service.js';

@Module({ controllers: [PlatformSecurityController, CollectionAdminController], providers: [PlatformSecurityService, CollectionAdminService] })
export class PlatformModule {}
