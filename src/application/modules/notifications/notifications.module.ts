import { Module, type DynamicModule } from '@nestjs/common';
import { defaultNotificationPorts, NOTIFICATION_PORTS, NotificationService, type NotificationPorts } from '../../services/notifications/notification.service.js';

@Module({})
export class NotificationsModule {
  static forRoot(ports: NotificationPorts = defaultNotificationPorts): DynamicModule {
    return {
      module: NotificationsModule,
      providers: [{ provide: NOTIFICATION_PORTS, useValue: ports }, NotificationService],
      exports: [NotificationService],
    };
  }
}
