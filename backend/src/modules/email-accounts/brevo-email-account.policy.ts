import { BadRequestException } from '@nestjs/common';

export const BREVO_SMTP_HOST = 'smtp-relay.brevo.com';

export function assertBrevoReceivingConfig(
  smtpHost: string,
  replyToEmail?: string | null,
) {
  if (smtpHost.trim().toLowerCase() !== BREVO_SMTP_HOST) return;

  const replyAddress = replyToEmail?.trim().toLowerCase() || '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(replyAddress)) {
    throw new BadRequestException(
      'Brevo accounts require a valid Reply-To / CRM receiving address',
    );
  }
}
