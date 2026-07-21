import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { DuplicateLeadsService } from './duplicate-leads.service';
import { QueryDuplicateLeadsDto } from './dto/query-duplicate-leads.dto';
import { UpdateDuplicateStatusDto } from './dto/update-duplicate-status.dto';
import { MergeDuplicateLeadsDto } from './dto/merge-duplicate-leads.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Duplicate Leads')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('duplicate-leads')
export class DuplicateLeadsController {
  constructor(private readonly duplicateLeadsService: DuplicateLeadsService) {}

  @Get()
  @ApiOperation({ summary: 'Get duplicate leads review list' })
  findAll(@CurrentUser() user: any, @Query() query: QueryDuplicateLeadsDto) {
    return this.duplicateLeadsService.findAll(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get duplicate lead detail with lead comparison' })
  findOne(@CurrentUser() user: any, @Param('id') id: string) {
    return this.duplicateLeadsService.findOne(id, user);
  }

  @Post('check/:leadId')
  @ApiOperation({ summary: 'Manually check a lead for duplicates' })
  checkLead(@CurrentUser() user: any, @Param('leadId') leadId: string) {
    return this.duplicateLeadsService.checkLead(leadId, user);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update duplicate record status (confirmed, not_duplicate, ignored)' })
  updateStatus(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateDuplicateStatusDto,
  ) {
    return this.duplicateLeadsService.updateStatus(id, dto, user);
  }

  @Post(':id/merge')
  @ApiOperation({ summary: 'Merge duplicate leads' })
  merge(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: MergeDuplicateLeadsDto,
  ) {
    return this.duplicateLeadsService.merge(id, dto, user);
  }

  @Get('by-lead/:leadId')
  @ApiOperation({ summary: 'Get pending duplicates for a specific lead' })
  getByLead(@CurrentUser() user: any, @Param('leadId') leadId: string) {
    return this.duplicateLeadsService.findByLead(leadId, user);
  }
}
