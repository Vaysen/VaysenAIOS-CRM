import { Body, Controller, Get, Header, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  OpenClawRuntimeQueryDto,
  OpenClawWechatPairingStartDto,
  OpenClawWechatPairingWaitDto,
} from './dto/openclaw-runtime.dto';
import { OpenClawRuntimeService } from './openclaw-runtime.service';
import type { AuthenticatedOpenClawUser } from './openclaw.types';

@ApiTags('AI Business Assistant')
@ApiBearerAuth()
@Controller('agent-runs/assistant')
export class OpenClawController {
  constructor(private readonly runtime: OpenClawRuntimeService) {}

  @Get('runtime')
  @ApiOperation({ summary: 'Read a sanitized OpenClaw and owner WeChat runtime snapshot' })
  getRuntime(
    @Query() query: OpenClawRuntimeQueryDto,
    @CurrentUser() user: AuthenticatedOpenClawUser,
  ) {
    return this.runtime.getSnapshot(query.companyId, user);
  }

  @Post('wechat-owner/pairing/start')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Start an authenticated in-page owner WeChat QR pairing flow' })
  startWechatPairing(
    @Body() body: OpenClawWechatPairingStartDto,
    @CurrentUser() user: AuthenticatedOpenClawUser,
  ) {
    return this.runtime.startWechatPairing(body.companyId, user);
  }

  @Post('wechat-owner/pairing/wait')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Wait for the authenticated owner WeChat QR pairing result' })
  waitWechatPairing(
    @Body() body: OpenClawWechatPairingWaitDto,
    @CurrentUser() user: AuthenticatedOpenClawUser,
  ) {
    return this.runtime.waitWechatPairing(body.companyId, body.pairingId, user);
  }
}
