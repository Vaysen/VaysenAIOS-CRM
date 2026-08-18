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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OpportunitiesService } from './opportunities.service';
import { CreateOpportunityDto } from './dto/create-opportunity.dto';
import { ListOpportunitiesDto } from './dto/list-opportunities.dto';
import { UpdateOpportunityDto } from './dto/update-opportunity.dto';
import { TransitionOpportunityDto } from './dto/transition-opportunity.dto';
import {
  CreateOpportunityContactRoleDto,
  UpdateOpportunityContactRoleDto,
} from './dto/opportunity-contact-role.dto';

@ApiTags('Opportunities')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('opportunities')
export class OpportunitiesController {
  constructor(private readonly opportunitiesService: OpportunitiesService) {}

  @Get()
  @ApiOperation({ summary: 'List accessible opportunities' })
  findAll(@Query() query: ListOpportunitiesDto, @CurrentUser() user: any) {
    return this.opportunitiesService.findAll(user, query);
  }

  @Post()
  @ApiOperation({ summary: 'Create an opportunity and its initial stage history' })
  create(@Body() dto: CreateOpportunityDto, @CurrentUser() user: any) {
    return this.opportunitiesService.create(dto, user);
  }

  @Get(':id/stage-history')
  @ApiOperation({ summary: 'Read opportunity stage history' })
  getHistory(@Param('id') id: string, @CurrentUser() user: any) {
    return this.opportunitiesService.getHistory(id, user);
  }

  @Post(':id/stage')
  @ApiOperation({ summary: 'Transition an opportunity stage with version CAS' })
  transition(
    @Param('id') id: string,
    @Body() dto: TransitionOpportunityDto,
    @CurrentUser() user: any,
  ) {
    return this.opportunitiesService.transition(id, dto, user);
  }

  @Get(':id/contact-roles')
  @ApiOperation({ summary: 'List opportunity contact roles' })
  listContactRoles(@Param('id') id: string, @CurrentUser() user: any) {
    return this.opportunitiesService.listContactRoles(id, user);
  }

  @Post(':id/contact-roles')
  @ApiOperation({ summary: 'Add an opportunity contact role' })
  addContactRole(
    @Param('id') id: string,
    @Body() dto: CreateOpportunityContactRoleDto,
    @CurrentUser() user: any,
  ) {
    return this.opportunitiesService.addContactRole(id, dto, user);
  }

  @Patch(':id/contact-roles/:roleId')
  @ApiOperation({ summary: 'Update an opportunity contact role' })
  updateContactRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @Body() dto: UpdateOpportunityContactRoleDto,
    @CurrentUser() user: any,
  ) {
    return this.opportunitiesService.updateContactRole(id, roleId, dto, user);
  }

  @Delete(':id/contact-roles/:roleId')
  @ApiOperation({ summary: 'Remove an opportunity contact role' })
  removeContactRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @CurrentUser() user: any,
  ) {
    return this.opportunitiesService.removeContactRole(id, roleId, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get opportunity detail' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.opportunitiesService.findOne(id, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update opportunity fields' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOpportunityDto,
    @CurrentUser() user: any,
  ) {
    return this.opportunitiesService.update(id, dto, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft delete opportunity' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.opportunitiesService.remove(id, user);
  }
}
