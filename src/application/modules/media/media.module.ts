import { Module, type DynamicModule } from '@nestjs/common';
import { ImageController } from '../../controllers/media/image.controller.js';
import { ImageProxyService, IMAGE_REQUESTER } from '../../services/media/image-proxy.service.js';
import type { ImageRequester } from '../../../infra/media/image-proxy.js';

@Module({})
export class MediaModule {
  static forRoot(options: { request?: ImageRequester } = {}): DynamicModule {
    return {
      module: MediaModule,
      controllers: [ImageController],
      providers: [ImageProxyService, { provide: IMAGE_REQUESTER, useValue: options.request }],
      exports: [ImageProxyService],
    };
  }
}
