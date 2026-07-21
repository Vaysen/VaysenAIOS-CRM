import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'List all users' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAll(
    @CurrentUser() user: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.usersService.findAll(user, { page, limit });
  }

  @Get('roles')
  @ApiOperation({ summary: 'Get available roles' })
  getRoles() {
    return this.usersService.getAvailableRoles();
  }

  @Post('change-password')
  @ApiOperation({ summary: 'Change current user password' })
  changePassword(
    @CurrentUser() user: any,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.usersService.changePassword(user.id, dto);
  }

  @Get('me/preferences')
  @ApiOperation({ summary: 'Get current user AI preferences' })
  getMyPreferences(@CurrentUser() user: any) {
    return this.usersService.getMyPreferences(user);
  }

  @Patch('me/preferences')
  @ApiOperation({ summary: 'Update current user AI preferences' })
  updateMyPreferences(
    @CurrentUser() user: any,
    @Body() dto: { aiPreference?: string },
  ) {
    return this.usersService.updateMyPreferences(user, dto.aiPreference || '');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user details' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.usersService.findOne(id, user);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new user' })
  create(@Body() dto: CreateUserDto, @CurrentUser() user: any) {
    return this.usersService.create(dto, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update user profile' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() user: any,
  ) {
    return this.usersService.update(id, dto, user);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Enable or disable user' })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
    @CurrentUser() user: any,
  ) {
    return this.usersService.updateStatus(id, dto.isActive, user);
  }

  @Patch(':id/role')
  @ApiOperation({ summary: 'Update user role in a company' })
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
    @CurrentUser() user: any,
    @Query('companyId') companyId: string,
  ) {
    return this.usersService.updateRole(id, dto.roleId, companyId, user);
  }

  @Patch(':id/admin-update')
  @ApiOperation({ summary: 'Admin update user (email, password, role, status)' })
  adminUpdate(
    @Param('id') id: string,
    @Body() dto: AdminUpdateUserDto,
    @CurrentUser() user: any,
  ) {
    return this.usersService.adminUpdate(id, dto, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft delete a user' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.usersService.remove(id, user);
  }
}
