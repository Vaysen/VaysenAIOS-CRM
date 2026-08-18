/**
 * sales-delivery.controller.ts
 *
 * wesley-ai-crm 批次3：报价交付回执链 HTTP 接口（全部走 JWT + 租户隔离）。
 * 供应商 Webhook（@Public + HMAC）见 sales-delivery-webhook.controller.ts。
 */

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SalesDeliveryService } from './sales-delivery.service';
import { SalesDeliveryRecoveryService } from './sales-delivery-recovery.service';
import { CreateRenderJobDto } from './dto/create-render-job.dto';
import { DispatchOutboundDto } from './dto/dispatch-outbound.dto';
import { CreateApprovalRequestDto } from './dto/approval-request.dto';
import { ApprovalDecisionDto } from './dto/approval-decision.dto';
import { CreateConnectionBindingDto } from './dto/create-connection-binding.dto';
import { WorkerHeartbeatDto } from './dto/worker-heartbeat.dto';

@ApiTags('Sales Delivery')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('sales-delivery')
export class SalesDeliveryController {
  constructor(
    private readonly service: SalesDeliveryService,
    private readonly recovery: SalesDeliveryRecoveryService,
  ) {}

  // ---------------------------------------------------------------- render jobs

  @Post('quotes/:id/render-jobs')
  @ApiOperation({ summary: 'Create (idempotent) a quote PDF render job' })
  createRenderJob(
    @Param('id') id: string,
    @Body() dto: CreateRenderJobDto,
    @CurrentUser() user: any,
  ) {
    return this.service.renderQuote(id, user, {
      forceRefresh: dto?.forceRefresh ?? false,
    });
  }

  @Get('quotes/:id/render-jobs')
  @ApiOperation({ summary: 'List render jobs for a quote' })
  listRenderJobs(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.listRenderJobs(id, user);
  }

  @Get('quotes/:id/render-jobs/:jobId')
  @ApiOperation({ summary: 'Get a render job by id' })
  getRenderJob(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.getRenderJob(id, jobId, user);
  }

  // ----------------------------------------------------------------- approvals

  @Post('quotes/:id/approval-requests')
  @ApiOperation({ summary: 'Create a human approval request for a quote delivery' })
  createApproval(
    @Param('id') id: string,
    @Body() dto: CreateApprovalRequestDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createApprovalRequest(id, dto, user);
  }

  @Post('quotes/:id/approval-requests/:approvalId/decisions')
  @ApiOperation({ summary: 'Decide an approval request (self-approval forbidden)' })
  decideApproval(
    @Param('id') id: string,
    @Param('approvalId') approvalId: string,
    @Body() dto: ApprovalDecisionDto,
    @CurrentUser() user: any,
  ) {
    return this.service.decideApproval(id, approvalId, dto, user);
  }

  // ---------------------------------------------------------------- deliveries

  @Post('quotes/:id/deliveries')
  @ApiOperation({
    summary: 'Dispatch a quote delivery (creates OutboundRequest + PENDING approval)',
  })
  deliver(
    @Param('id') id: string,
    @Body() dto: DispatchOutboundDto,
    @CurrentUser() user: any,
  ) {
    return this.service.dispatchOutbound(id, dto, user);
  }

  // --------------------------------------------------------- outbound requests

  @Get('outbound-requests/:id')
  @ApiOperation({ summary: 'Get an outbound request with receipts/approvals' })
  getOutbound(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.getOutbound(id, user);
  }

  @Post('outbound-requests/:id/preflight')
  @ApiOperation({ summary: 'Preflight gates before dispatch' })
  preflight(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.preflight(id, user);
  }

  @Post('outbound-requests/:id/approval-requests')
  @ApiOperation({ summary: 'Create an approval request for an outbound request' })
  createOutboundApproval(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.createOutboundApprovalRequest(id, user);
  }

  @Post('outbound-requests/:id/approval-decisions')
  @ApiOperation({ summary: 'Decide the pending approval of an outbound request' })
  decideOutboundApproval(
    @Param('id') id: string,
    @Body() dto: ApprovalDecisionDto,
    @CurrentUser() user: any,
  ) {
    return this.service.decideOutboundApproval(id, dto, user);
  }

  @Post('outbound-requests/:id/dispatch')
  @ApiOperation({ summary: 'Dispatch (send) an approved outbound request' })
  dispatch(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.dispatchOutboundById(id, user);
  }

  @Post('outbound-requests/:id/reconcile')
  @ApiOperation({ summary: 'Reconcile an UNKNOWN outbound by its latest receipt' })
  reconcileOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.reconcileOne(id, user);
  }

  @Post('outbound-requests/:id/cancel')
  @ApiOperation({ summary: 'Cancel an outbound request (non-terminal states only)' })
  cancel(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.cancel(id, user);
  }

  // -------------------------------------------------------- connection bindings

  @Get('connection-bindings')
  @ApiOperation({ summary: 'List delivery connection bindings' })
  listBindings(@CurrentUser() user: any) {
    return this.service.listConnectionBindings(user);
  }

  @Post('connection-bindings')
  @ApiOperation({ summary: 'Create a delivery connection binding (idempotent)' })
  createBinding(@Body() dto: CreateConnectionBindingDto, @CurrentUser() user: any) {
    return this.service.createConnectionBinding(dto, user);
  }

  // ------------------------------------------------------ recovery & heartbeats

  @Post('recovery/run')
  @ApiOperation({ summary: 'Run one recovery pass (leases, retries, dead letters, heartbeats)' })
  runRecovery(@CurrentUser() user: any) {
    return this.recovery.run(user);
  }

  @Post('worker-heartbeats')
  @ApiOperation({ summary: 'Report a delivery worker heartbeat' })
  heartbeat(@Body() dto: WorkerHeartbeatDto, @CurrentUser() user: any) {
    return this.recovery.heartbeat(dto.workerId, dto.nodeId, user?.activeCompanyId);
  }

  @Get('worker-heartbeats')
  @ApiOperation({ summary: 'List worker heartbeats for the active tenant' })
  heartbeats(@CurrentUser() user: any) {
    return this.recovery.listHeartbeats(user);
  }
}
