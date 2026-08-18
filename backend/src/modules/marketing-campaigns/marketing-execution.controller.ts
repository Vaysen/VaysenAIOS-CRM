import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MarketingExecutionService } from './marketing-execution.service';
import { PreviewGateDto, PreviewRecoveryDto } from './dto/preview-gate.dto';

@ApiTags('Marketing Execution')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('marketing-execution')
export class MarketingExecutionController {
  constructor(private readonly service: MarketingExecutionService) {}

  @Get('capabilities')
  capabilities(@CurrentUser() user: any) {
    return this.service.capabilities(user);
  }

  @Post('preview-gate')
  previewGate(@Body() dto: PreviewGateDto, @CurrentUser() user: any) {
    return this.service.previewGate(dto, user);
  }

  @Post('preview-recovery')
  previewRecovery(@Body() dto: PreviewRecoveryDto, @CurrentUser() user: any) {
    return this.service.previewRecovery(dto, user);
  }

  // R111 批次D：投放运行列表（数据看板）
  @Get('delivery-runs')
  @ApiOperation({ summary: '投放运行列表 + 状态分布（数据看板）' })
  @ApiQuery({ name: 'limit', required: false, description: '条数，默认 20' })
  @ApiQuery({ name: 'campaignId', required: false, description: '按活动过滤' })
  @ApiQuery({ name: 'status', required: false, description: '按投放运行状态过滤' })
  deliveryRuns(@CurrentUser() user: any, @Query() query: any) {
    return this.service.getDeliveryRuns(user, query);
  }
}
