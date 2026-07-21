import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { CompaniesService } from './companies.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { AddCompanyUserDto } from './dto/add-company-user.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Companies')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('companies')
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Get()
  @ApiOperation({ summary: 'List companies' })
  findAll(@CurrentUser() user: any) {
    return this.companiesService.findAll(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get company details' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.companiesService.findOne(id, user);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new company' })
  create(@Body() dto: CreateCompanyDto, @CurrentUser() user: any) {
    return this.companiesService.create(dto, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update company profile' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCompanyDto,
    @CurrentUser() user: any,
  ) {
    return this.companiesService.update(id, dto, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a company (Super Admin only)' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.companiesService.remove(id, user);
  }

  @Get(':id/users')
  @ApiOperation({ summary: 'List company users' })
  getUsers(@Param('id') id: string, @CurrentUser() user: any) {
    return this.companiesService.getCompanyUsers(id, user);
  }

  @Post(':id/users')
  @ApiOperation({ summary: 'Add user to company' })
  addUser(
    @Param('id') id: string,
    @Body() dto: AddCompanyUserDto,
    @CurrentUser() user: any,
  ) {
    return this.companiesService.addUser(id, dto, user);
  }

  @Delete(':id/users/:userId')
  @ApiOperation({ summary: 'Remove user from company' })
  removeUser(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: any,
  ) {
    return this.companiesService.removeUser(id, userId, user);
  }
}
