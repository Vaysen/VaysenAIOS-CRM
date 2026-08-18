import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OutboundComplianceService } from './outbound-compliance.service';
import {
  CancelOutboundActionDto,
  CompanyActionDto,
  ListOutboundActionsDto,
  OutboundActionIdDto,
  OutboundActionKeyDto,
  ReconcileOutboundActionDto,
} from './dto/outbound-action.dto';

@ApiTags('Outbound compliance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('outbound-actions')
export class OutboundController {
  constructor(private readonly outbound: OutboundComplianceService) {}

  @Get()
  @ApiOperation({ summary: 'List tenant outbound actions, including UNKNOWN actions requiring reconciliation' })
  list(@Query() query: ListOutboundActionsDto, @CurrentUser() user: any) {
    return this.outbound.listActions(query.companyId, user, query);
  }

  @Get('by-key/:idempotencyKey')
  @ApiOperation({ summary: 'Get an outbound action by its canonical tenant idempotency key' })
  getByKey(
    @Param() params: OutboundActionKeyDto,
    @Query() query: CompanyActionDto,
    @CurrentUser() user: any,
  ) {
    return this.outbound.getActionByKey(query.companyId, params.idempotencyKey, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one tenant outbound action' })
  get(
    @Param() params: OutboundActionIdDto,
    @Query() query: CompanyActionDto,
    @CurrentUser() user: any,
  ) {
    return this.outbound.getAction(query.companyId, params.id, user);
  }

  @Post('recover-stale')
  @ApiOperation({ summary: 'Move expired EXECUTING leases to UNKNOWN for manual reconciliation' })
  recoverStale(
    @Body() body: CompanyActionDto,
    @CurrentUser() user: any,
  ) {
    return this.outbound.recoverStaleExecuting(body.companyId, user);
  }

  @Post('cancel')
  @ApiOperation({ summary: 'Cancel a pending or failed external action' })
  cancel(
    @Body() body: CancelOutboundActionDto,
    @CurrentUser() user: any,
  ) {
    return this.outbound.cancel(body.companyId, body.idempotencyKey, user);
  }

  @Post(':id/reconcile')
  @ApiOperation({ summary: 'Administrator reconciliation for an UNKNOWN provider outcome' })
  reconcile(
    @Param() params: OutboundActionIdDto,
    @Body() body: ReconcileOutboundActionDto,
    @CurrentUser() user: any,
  ) {
    return this.outbound.reconcileUnknown(
      body.companyId,
      params.id,
      body.outcome,
      user,
      {
        reason: body.reason,
        evidenceReference: body.evidenceReference,
      },
      body.provider && body.providerReceiptId
        ? {
            provider: body.provider,
            receiptId: body.providerReceiptId,
            acceptedAt: body.acceptedAt,
          }
        : undefined,
    );
  }
}
