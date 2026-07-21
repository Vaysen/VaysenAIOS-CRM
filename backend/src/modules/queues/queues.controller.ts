import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { QueuesService } from './queues.service';
import { CurrentUser } from '@/common/decorators/current-user.decorator';

@ApiTags('Queues')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('queues')
export class QueuesController {
  constructor(private readonly queuesService: QueuesService) {}

  @Get('status')
  getStatus(@CurrentUser() user: any) {
    return this.queuesService.getStatus(user);
  }
}
