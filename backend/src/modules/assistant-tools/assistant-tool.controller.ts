import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AssistantToolService } from './assistant-tool.service';

@ApiTags('LAN AI Assistant Tools')
@ApiBearerAuth()
@Controller('assistant-tools')
export class AssistantToolController {
  constructor(private readonly tools: AssistantToolService) {}

  @Get('registry')
  @ApiOperation({ summary: 'Read the fixed LAN assistant tool registry and schemas' })
  registry() { return this.tools.registry(); }

  @Get('provider')
  provider() { return this.tools.providerConfig(); }

  @Post('provider/test')
  providerTest() { return this.tools.providerConnectionTest(); }

  @Get('history')
  history(@Query('companyId') companyId: string, @CurrentUser() user: any) { return this.tools.history(companyId, user); }

  @Post('plan')
  @ApiOperation({ summary: 'Plan a deterministic assistant tool call; writes stop for confirmation' })
  plan(@Body() body: any, @CurrentUser() user: any) { return this.tools.plan(body, user); }

  @Post(':id/confirm')
  confirm(@Param('id') id: string, @CurrentUser() user: any) { return this.tools.confirm(id, user); }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: any) { return this.tools.cancel(id, user); }
}
