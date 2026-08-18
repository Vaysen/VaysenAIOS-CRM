import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateFactProposalDto } from './dto/create-fact-proposal.dto';
import { FactCommandDto } from './dto/fact-command.dto';
import { LegacyFactDryRunDto } from './dto/legacy-fact-dry-run.dto';
import { CustomerFactsService } from './customer-facts.service';

@ApiTags('Customer Facts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('customer-facts')
export class CustomerFactsController {
  constructor(private readonly service: CustomerFactsService) {}

  @Get()
  list(@CurrentUser() user: any) { return this.service.list(user); }

  @Get('proposals')
  listProposals(@CurrentUser() user: any) { return this.service.listProposals(user); }

  @Post('legacy/dry-run')
  legacyDryRun(@Body() dto: LegacyFactDryRunDto, @CurrentUser() user: any) { return this.service.legacyDryRun(dto, user); }

  @Post('proposals')
  createProposal(@Body() dto: CreateFactProposalDto, @CurrentUser() user: any) { return this.service.createProposal(dto, user); }

  @Post('proposals/:id/accept')
  accept(@Param('id') id: string, @Body() dto: FactCommandDto, @CurrentUser() user: any) { return this.service.acceptProposal(id, dto, user); }

  @Post('proposals/:id/reject')
  reject(@Param('id') id: string, @Body() dto: FactCommandDto, @CurrentUser() user: any) { return this.service.rejectProposal(id, dto, user); }
}
