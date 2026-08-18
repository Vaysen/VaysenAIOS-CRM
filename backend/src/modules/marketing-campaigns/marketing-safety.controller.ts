import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MarketingSafetyService } from './marketing-safety.service';
import { ActivateKillSwitchDto } from './dto/kill-switch.dto';

@ApiTags('Marketing Safety')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('marketing-safety')
export class MarketingSafetyController {
  constructor(private readonly service: MarketingSafetyService) {}

  @Get('capabilities')
  capabilities(@CurrentUser() user: any) {
    return this.service.capabilities(user);
  }

  @Get('kill-switches')
  listKillSwitches(@CurrentUser() user: any) {
    return this.service.listKillSwitches(user);
  }

  @Post('kill-switches')
  activateKillSwitch(@Body() dto: ActivateKillSwitchDto, @CurrentUser() user: any) {
    return this.service.activateKillSwitch(dto, user);
  }

  @Post('kill-switches/:id/deactivate')
  deactivateKillSwitch(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.deactivateKillSwitch(id, user);
  }

  @Get('preflight-runs/:id')
  getPreflightRun(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.getPreflightRun(id, user);
  }
}
