import { Controller, Get, Post, Patch, Param, Query, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrdersService, CreateOrderDto } from './orders.service';

@ApiTags('Orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @ApiOperation({ summary: 'List all orders (company-scoped)' })
  findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('stage') stage?: string,
    @Query('leadId') leadId?: string,
    @CurrentUser() user?: any,
  ) {
    return this.ordersService.findAll(user, {
      page: Number(page) || 1,
      limit: Number(limit) || 50,
      stage,
      leadId,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get order detail' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.ordersService.findOne(id, user);
  }

  @Post()
  @ApiOperation({ summary: 'Create an order' })
  create(@Body() dto: CreateOrderDto, @CurrentUser() user: any) {
    return this.ordersService.create(dto, user);
  }

  @Patch(':id/stage')
  @ApiOperation({ summary: 'Update order stage' })
  updateStage(@Param('id') id: string, @Body('stage') stage: string, @CurrentUser() user: any) {
    return this.ordersService.updateStage(id, stage, user);
  }

  @Get('lead/:leadId/history')
  @ApiOperation({ summary: 'Get customer order history' })
  customerHistory(@Param('leadId') leadId: string, @CurrentUser() user: any) {
    return this.ordersService.getCustomerOrderHistory(leadId, user);
  }
}
