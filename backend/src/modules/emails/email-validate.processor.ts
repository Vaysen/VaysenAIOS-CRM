import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '@/common/prisma/prisma.service';
import { QUEUES } from '@/common/queues/queue-names';
import { findLegacyEmailBrandReference, validateEmailContent } from './email-content.guard';
import { prepareEmailForExternalDelivery } from './email-public-links';

type ValidateJob = {
  emailMessageId: string;
  aiPersonalize?: boolean;
  sendDelayMs?: number;
};

@Processor(QUEUES.emailValidate, { concurrency: Number(process.env.EMAIL_VALIDATE_CONCURRENCY || 5) })
export class EmailValidateProcessor extends WorkerHost {
  constructor(
    private prisma: PrismaService,
    @InjectQueue(QUEUES.emailCompose) private emailComposeQueue: Queue,
    @InjectQueue(QUEUES.emailSend) private emailSendQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<ValidateJob>): Promise<any> {
    const { emailMessageId, aiPersonalize, sendDelayMs } = job.data;
    const msg = await this.prisma.emailMessage.findUnique({
      where: { id: emailMessageId },
      include: { company: true, emailAccount: true },
    });
    if (!msg || msg.deletedAt) return { success: false, reason: 'Email message not found' };
    if (msg.status === 'Sent') return { success: true, reason: 'Already sent' };

    const deliverableHtml = prepareEmailForExternalDelivery(msg.bodyHtml || '');
    const legacyEnvelope = findLegacyEmailBrandReference(
      msg.emailAccount?.senderName,
      msg.emailAccount?.senderEmail,
      msg.emailAccount?.replyToEmail,
    );
    if (legacyEnvelope) {
      return this.requeueForComposeOrFail(
        msg,
        `Email sender contains a retired brand or domain: ${legacyEnvelope}`,
        !!aiPersonalize,
        sendDelayMs || 0,
      );
    }
    const content = validateEmailContent(msg.subject, deliverableHtml, msg.company?.website);
    if (!content.valid) {
      return this.requeueForComposeOrFail(msg, content.reason || 'Email content validation failed', !!aiPersonalize, sendDelayMs || 0);
    }

    await this.prisma.emailMessage.update({
      where: { id: msg.id },
      data: {
        bodyHtml: deliverableHtml,
        status: 'QueuedToSend',
        failedReason: null,
        errorMessage: null,
      },
    });

    await this.emailSendQueue.add(
      'send-email',
      { emailMessageId: msg.id, aiPersonalize: !!aiPersonalize },
      {
        delay: Math.max(0, sendDelayMs || 0),
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );

    return { success: true, emailMessageId: msg.id };
  }

  private async requeueForComposeOrFail(msg: any, reason: string, aiPersonalize: boolean, sendDelayMs: number) {
    const retryCount = msg.retryCount + 1;
    if (aiPersonalize && retryCount <= msg.maxRetries && msg.templateId) {
      await this.prisma.emailMessage.update({
        where: { id: msg.id },
        data: { status: 'ValidationFailed', retryCount, failedReason: reason, errorMessage: reason },
      });
      await this.emailComposeQueue.add(
        'compose-email',
        { emailMessageId: msg.id, sendDelayMs, aiPersonalize: true },
        {
          delay: 5000,
          attempts: 3,
          backoff: { type: 'exponential', delay: 10000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
      return { success: false, requeued: true, reason };
    }

    await this.prisma.emailMessage.update({
      where: { id: msg.id },
      data: {
        status: aiPersonalize ? 'DraftFailed' : 'Failed',
        failedAt: new Date(),
        failedReason: reason,
        errorMessage: reason,
      },
    });
    return { success: false, reason };
  }
}
