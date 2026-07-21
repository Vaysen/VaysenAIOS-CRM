import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { EmailAccountsService } from './email-accounts.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateEmailAccountDto } from './dto/create-email-account.dto';
import { UpdateEmailAccountDto } from './dto/update-email-account.dto';
import { UpdateEmailAccountStatusDto } from './dto/update-email-account-status.dto';
import { TestEmailDto } from './dto/test-email.dto';

@ApiTags('Email Accounts')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('email-accounts')
export class EmailAccountsController {
  constructor(private readonly emailAccountsService: EmailAccountsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all email accounts' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by status' })
  findAll(
    @CurrentUser() user: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
  ) {
    return this.emailAccountsService.findAll(user, { page, limit, status });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get email account detail' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.emailAccountsService.findOne(id, user);
  }

  @Post()
  @ApiOperation({ summary: 'Create email account' })
  create(@Body() dto: CreateEmailAccountDto, @CurrentUser() user: any) {
    return this.emailAccountsService.create(dto, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update email account' })
  update(@Param('id') id: string, @Body() dto: UpdateEmailAccountDto, @CurrentUser() user: any) {
    return this.emailAccountsService.update(id, dto, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Deactivate email account (soft delete)' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.emailAccountsService.remove(id, user);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update email account status (enable/disable)' })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateEmailAccountStatusDto,
    @CurrentUser() user: any,
  ) {
    return this.emailAccountsService.updateStatus(id, dto, user);
  }

  @Post(':id/test-connection')
  @ApiOperation({ summary: 'Test SMTP connection' })
  testConnection(@Param('id') id: string, @CurrentUser() user: any) {
    return this.emailAccountsService.testConnection(id, user);
  }

  @Post(':id/send-test')
  @ApiOperation({ summary: 'Send a test email' })
  sendTest(
    @Param('id') id: string,
    @Body() dto: TestEmailDto,
    @CurrentUser() user: any,
  ) {
    return this.emailAccountsService.sendTest(id, dto.recipientEmail, user);
  }
}
