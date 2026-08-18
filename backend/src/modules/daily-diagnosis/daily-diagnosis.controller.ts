import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DailyDiagnosisService } from './daily-diagnosis.service';

@ApiTags('Daily Diagnosis')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('daily-diagnosis')
export class DailyDiagnosisController {
  constructor(private readonly service: DailyDiagnosisService) {}

  @Get('today')
  @ApiOperation({ summary: '每日 AI 运营诊断快照（Asia/Shanghai 工作日，当日幂等）' })
  @ApiQuery({ name: 'companyId', required: false, description: '公司 ID，缺省用当前活跃公司' })
  today(@CurrentUser() user: any, @Query('companyId') companyId?: string) {
    return this.service.getToday(user, companyId);
  }

  @Post('regenerate')
  @ApiOperation({ summary: '管理员强制重新生成当日诊断快照' })
  @ApiQuery({ name: 'companyId', required: false, description: '公司 ID，缺省用当前活跃公司' })
  regenerate(@CurrentUser() user: any, @Query('companyId') companyId?: string) {
    return this.service.regenerate(user, companyId);
  }
}
