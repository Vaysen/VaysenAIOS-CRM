import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { LeadScoresService } from './lead-scores.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Lead Scores')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('lead-scores')
export class LeadScoresController {
  constructor(private readonly leadScoresService: LeadScoresService) {}

  @Get()
  @ApiOperation({ summary: 'Get all lead scores with grade distribution' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'grade', required: false, description: 'Filter by grade (A, B, C, D)' })
  @ApiQuery({ name: 'companyId', required: false, description: 'Filter by company (super admin only)' })
  findAll(
    @CurrentUser() user: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('grade') grade?: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.leadScoresService.findAll(user, { page, limit, grade, companyId });
  }
}
