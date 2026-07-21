import { Global, Module } from '@nestjs/common';
import { OpenClawGatewayClient } from '../openclaw/openclaw-gateway.client';
import { OpenClawOwnerNotificationSender } from './openclaw-owner-notification.sender';
import { OwnerNotificationDispatcher } from './owner-notification.dispatcher';
import { OwnerNotificationService } from './owner-notification.service';
import { OWNER_NOTIFICATION_SENDER } from './owner-notification.types';
import { OwnerNotificationsController } from './owner-notifications.controller';

@Global()
@Module({
  controllers: [OwnerNotificationsController],
  providers: [
    OwnerNotificationService,
    // The gateway client has no Nest dependencies. Providing the small client
    // locally avoids a module cycle: OpenClaw -> WhatsApp -> notifications.
    OpenClawGatewayClient,
    OpenClawOwnerNotificationSender,
    {
      provide: OWNER_NOTIFICATION_SENDER,
      useExisting: OpenClawOwnerNotificationSender,
    },
    OwnerNotificationDispatcher,
  ],
  exports: [OwnerNotificationService, OwnerNotificationDispatcher],
})
export class OwnerNotificationsModule {}
