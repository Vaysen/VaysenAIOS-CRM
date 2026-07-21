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
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { EmailTemplatesService } from './email-templates.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateEmailTemplateDto } from './dto/create-email-template.dto';
import { UpdateEmailTemplateDto } from './dto/update-email-template.dto';
import { PreviewEmailTemplateDto } from './dto/preview-email-template.dto';

@ApiTags('Email Templates')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('email-templates')
export class EmailTemplatesController {
  constructor(private readonly emailTemplatesService: EmailTemplatesService) {}

  @Get()
  @ApiOperation({ summary: 'Get all email templates' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'category', required: false, description: 'Filter by category' })
  @ApiQuery({ name: 'language', required: false, description: 'Filter by language' })
  @ApiQuery({ name: 'productCategory', required: false, description: 'Filter by product category' })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean, description: 'Filter by active status' })
  @ApiQuery({ name: 'search', required: false, description: 'Search by name or subject' })
  findAll(
    @CurrentUser() user: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('category') category?: string,
    @Query('language') language?: string,
    @Query('productCategory') productCategory?: string,
    @Query('isActive') isActive?: string,
    @Query('search') search?: string,
  ) {
    return this.emailTemplatesService.findAll(user, {
      page,
      limit,
      category,
      language,
      productCategory,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      search,
    });
  }

  @Post('ai-generate')
  @ApiOperation({ summary: 'Generate an AI email template shell' })
  generateAiTemplate(@Body() dto: any, @CurrentUser() user: any) {
    return this.emailTemplatesService.generateAiTemplate(dto, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get email template detail' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.emailTemplatesService.findOne(id, user);
  }

  @Post()
  @ApiOperation({ summary: 'Create email template' })
  create(@Body() dto: CreateEmailTemplateDto, @CurrentUser() user: any) {
    return this.emailTemplatesService.create(dto, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update email template' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateEmailTemplateDto,
    @CurrentUser() user: any,
  ) {
    return this.emailTemplatesService.update(id, dto, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Deactivate email template (soft delete)' })
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.emailTemplatesService.remove(id, user);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Enable/disable email template' })
  updateStatus(
    @Param('id') id: string,
    @Body('isActive') isActive: boolean,
    @CurrentUser() user: any,
  ) {
    return this.emailTemplatesService.updateStatus(id, isActive, user);
  }

  @Post(':id/preview')
  @ApiOperation({ summary: 'Preview template with variable substitution' })
  preview(
    @Param('id') id: string,
    @Body() dto: PreviewEmailTemplateDto,
    @CurrentUser() user: any,
  ) {
    return this.emailTemplatesService.preview(id, dto.variables, user);
  }
}
