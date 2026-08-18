import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateSalesSequenceDto } from './dto/create-sales-sequence.dto';
import { EnrollSalesSequenceDto } from './dto/enroll-sales-sequence.dto';
import { SalesSequencesService } from './sales-sequences.service';

@ApiTags('Sales Sequences')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('sales-sequences')
export class SalesSequencesController {
  constructor(private readonly service: SalesSequencesService) {}

  @Get()
  list(@CurrentUser() user: any) { return this.service.list(user); }

  @Post()
  create(@Body() dto: CreateSalesSequenceDto, @CurrentUser() user: any) { return this.service.create(dto, user); }

  @Post(':id/activate')
  activate(@Param('id') id: string, @CurrentUser() user: any) { return this.service.activate(id, user); }

  @Post(':id/enrollments')
  enroll(@Param('id') id: string, @Body() dto: EnrollSalesSequenceDto, @CurrentUser() user: any) { return this.service.enroll(id, dto, user); }

  @Get(':id/enrollments')
  listEnrollments(@Param('id') id: string, @CurrentUser() user: any) { return this.service.listEnrollments(id, user); }

  @Post('executions/:id/approve')
  approve(@Param('id') id: string, @CurrentUser() user: any) { return this.service.transitionExecution(id, 'APPROVE', user); }

  @Post('executions/:id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: any) { return this.service.transitionExecution(id, 'CANCEL', user); }
}
