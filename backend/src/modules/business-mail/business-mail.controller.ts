import { Controller, Post, Body, Param, UseGuards } from '@nestjs/common';
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
  send(@Body() dto: SendMailDto, @CurrentUser() user: any) {
    return this.businessMailService.sendMail(dto, user);
  }

  @Post('test-smtp/:accountId')
  @ApiOperation({ summary: 'Test SMTP connection for an email account' })
  testSmtp(@Param('accountId') accountId: string, @CurrentUser() user: any) {
    return this.businessMailService.testSmtp(accountId, user);
  }
}
