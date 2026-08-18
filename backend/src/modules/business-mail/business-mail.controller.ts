import { Controller, Post, Body, Param, UseGuards, Headers } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BusinessMailService } from './business-mail.service';
import { SendMailDto } from './dto/send-mail.dto';

@ApiTags('Business Mail')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('business-mail')
export class BusinessMailController {
  constructor(private readonly businessMailService: BusinessMailService) {}

  @Post('send')
  @ApiOperation({ summary: 'Send a one-to-one business email (SMTP)' })
  send(
    @Body() dto: SendMailDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: any,
  ) {
    return this.businessMailService.sendMail(
      {
        emailAccountId: dto.emailAccountId,
        to: dto.to,
        subject: dto.subject,
        html: dto.html,
        conversationId: dto.conversationId,
        leadId: dto.leadId,
        attachments: dto.attachments?.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          mimeType: attachment.mimeType,
        })),
        idempotencyKey: idempotencyKey || dto.idempotencyKey,
        actorType: 'HUMAN',
        actionType: 'RAW_SMTP',
      },
      user,
    );
  }

  @Post('test-smtp/:accountId')
  @ApiOperation({ summary: 'Test SMTP connection for an email account' })
  testSmtp(@Param('accountId') accountId: string, @CurrentUser() user: any) {
    return this.businessMailService.testSmtp(accountId, user);
  }
}
