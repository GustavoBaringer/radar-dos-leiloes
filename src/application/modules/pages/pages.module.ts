import { Module } from '@nestjs/common';
import { PagesController } from '../../controllers/pages/pages.controller.js';
import { PagesService } from '../../services/pages/pages.service.js';
import { PagesRepository } from '../../../infra/web/pages.repository.js';

@Module({ controllers: [PagesController], providers: [PagesService, PagesRepository] })
export class PagesModule {}
