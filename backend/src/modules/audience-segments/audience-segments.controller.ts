/**
 * audience-segments.controller.ts
 *
 * R111 批次A 客群系统：HTTP 路由（挂载于 /api/audience-segments）。
 * 租户隔离由 service 层 requireActiveCompany 保证，认证沿用 JwtAuthGuard。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AudienceSegmentsService } from './audience-segments.service';
import { CreateAudienceSegmentDto } from './dto/create-audience-segment.dto';
import { UpdateAudienceSegmentDto } from './dto/update-audience-segment.dto';
import { AddMembersDto } from './dto/add-members.dto';
import { QueryAudienceSegmentsDto } from './dto/query-audience-segments.dto';

@ApiTags('Audience Segments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('audience-segments')
export class AudienceSegmentsController {
  constructor(private readonly service: AudienceSegmentsService) {}

  @Get()
  list(@Query() query: QueryAudienceSegmentsDto, @CurrentUser() user: any) {
    return this.service.list(user, query);
  }

  @Post()
  create(@Body() dto: CreateAudienceSegmentDto, @CurrentUser() user: any) {
    return this.service.create(dto, user);
  }

  @Get(':id')
  get(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Query('includeMembers') includeMembers?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.get(id, user, {
      includeMembers: includeMembers === 'true',
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAudienceSegmentDto, @CurrentUser() user: any) {
    return this.service.update(id, dto, user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.remove(id, user);
  }

  @Post(':id/refresh')
  refresh(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.refresh(id, user);
  }

  @Post(':id/members')
  addMembers(@Param('id') id: string, @Body() dto: AddMembersDto, @CurrentUser() user: any) {
    return this.service.addMembers(id, dto, user);
  }

  @Delete(':id/members/:memberId')
  removeMember(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.removeMember(id, memberId, user);
  }

  @Get(':id/preview-count')
  previewCount(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.previewCount(id, user);
  }

  @Get(':id/export')
  export(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.export(id, user);
  }
}
