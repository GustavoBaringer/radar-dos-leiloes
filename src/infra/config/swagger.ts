import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function configureSwagger(app: INestApplication): void {
  if (process.env.NODE_ENV === 'production') return;
  const config = new DocumentBuilder().setTitle('Radar de Leilões API').setVersion('1.0').build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
}
