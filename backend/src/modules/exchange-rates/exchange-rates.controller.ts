import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ExchangeRatesService } from './exchange-rates.service';

@ApiTags('Exchange Rates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('exchange-rates')
export class ExchangeRatesController {
  constructor(private readonly service: ExchangeRatesService) {}

  @Get('latest')
  @ApiOperation({ summary: '最新汇率（CNY base，fallback 链：jsDelivr→pages.dev→frankfurter→静态兜底）' })
  latest() {
    return this.service.getLatest();
  }
}
