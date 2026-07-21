import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { ContinuousProspectService } from './continuous-prospect.service';

@ApiTags('Continuous Prospect')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('continuous-prospect')
export class ContinuousProspectController {
  constructor(private readonly service: ContinuousProspectService) {}

  @Get('status')
  status() {
    return this.service.getStatus();
  }

  @Post('start')
  start() {
    return this.service.start();
  }

  @Post('pause')
  pause() {
    return this.service.pause();
  }

  @Post('resume')
  resume() {
    return this.service.resume();
  }

  @Post('stop')
  stop() {
    return this.service.stop();
  }
}
