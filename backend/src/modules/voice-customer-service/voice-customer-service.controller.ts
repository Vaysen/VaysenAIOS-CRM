import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateVoiceTestSessionDto, EndVoiceCallDto, RequestVoiceHandoffDto } from './dto/voice-call.dto';
import { VoiceCustomerServiceService } from './voice-customer-service.service';

@ApiTags('AI Voice Customer Service')
@ApiBearerAuth()
@Controller('voice-calls')
export class VoiceCustomerServiceController {
  constructor(private readonly service: VoiceCustomerServiceService) {}

  @Get()
  @ApiOperation({ summary: 'List company-scoped voice call sessions' })
  list(@CurrentUser() user: any, @Query('status') status?: string) { return this.service.list(user, status); }

  @Get(':id')
  @ApiOperation({ summary: 'Get voice call, CRM conversation and audit events' })
  findOne(@CurrentUser() user: any, @Param('id') id: string) { return this.service.findOne(user, id); }

  @Post('test-session')
  @ApiOperation({ summary: 'Create a safe LAN WebRTC test placeholder (does not dial)' })
  createTest(@CurrentUser() user: any, @Body() dto: CreateVoiceTestSessionDto) { return this.service.createTestSession(user, dto); }

  @Post(':id/handoff')
  @ApiOperation({ summary: 'Request an audited human handoff with context' })
  handoff(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: RequestVoiceHandoffDto) { return this.service.requestHandoff(user, id, dto); }

  @Post(':id/end')
  @ApiOperation({ summary: 'End a voice call and close its CRM conversation' })
  end(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: EndVoiceCallDto) { return this.service.end(user, id, dto); }
}
