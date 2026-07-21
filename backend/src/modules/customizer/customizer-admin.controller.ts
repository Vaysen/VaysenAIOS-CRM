import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CustomizerService } from './customizer.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { PublishTemplateDto } from './dto/publish-template.dto';
import { SetRegionsDto } from './dto/set-regions.dto';
import { UpdateRegionDto } from './dto/update-region.dto';
import { CreateMaterialDto, UpdateMaterialDto } from './dto/material.dto';
import { CreateLogoEffectDto, UpdateLogoEffectDto } from './dto/effect.dto';
import { QueryInquiriesDto } from './dto/inquiry.dto';
import {
  FileValidationInterceptor,
  ValidateFile,
} from './file-validation.interceptor';

/* ========================================
   Customizer Admin Controller (TASK-046)
   - All endpoints require JWT auth (no @Public())
   - Global JwtAuthGuard enforces authentication
   - File upload endpoints have validation
   ======================================== */

@ApiTags('Customizer Admin')
@ApiBearerAuth()
@Controller('customizer/admin')
export class CustomizerAdminController {
  constructor(private readonly customizerService: CustomizerService) {}

  // === Dashboard (Admin) ===

  @Get('dashboard/stats')
  @ApiOperation({ summary: 'Get dashboard statistics (admin)' })
  getDashboardStats(@CurrentUser() user: any) {
    return this.customizerService.getDashboardStats(user);
  }

  @Get('dashboard/recent-inquiries')
  @ApiOperation({ summary: 'Get recent inquiries (admin)' })
  getRecentInquiries(
    @Query('limit') limit?: string,
    @CurrentUser() user?: any,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : 5;
    return this.customizerService.getRecentInquiries(parsedLimit, user);
  }

  @Get('dashboard/recent-designs')
  @ApiOperation({ summary: 'Get recent designs (admin)' })
  getRecentDesigns(
    @Query('limit') limit?: string,
    @CurrentUser() user?: any,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : 5;
    return this.customizerService.getRecentDesigns(parsedLimit, user);
  }

  // === Template Management (TASK-005) — Admin Only ===

  @Post('templates')
  @ApiOperation({ summary: 'Create a new customizer template (admin)' })
  createTemplate(@Body() dto: CreateTemplateDto, @CurrentUser() user: any) {
    return this.customizerService.createTemplate(dto, user);
  }

  @Put('templates/:id')
  @ApiOperation({ summary: 'Update template information (admin)' })
  updateTemplate(
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.updateTemplate(id, dto, user);
  }

  @Patch('templates/:id/publish')
  @ApiOperation({ summary: 'Publish or unpublish a template (admin)' })
  publishTemplate(
    @Param('id') id: string,
    @Body() dto: PublishTemplateDto,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.publishTemplate(id, dto.published, user);
  }

  @Get('templates')
  @ApiOperation({ summary: 'List all templates including unpublished (admin)' })
  listTemplates(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @CurrentUser() user?: any,
  ) {
    return this.customizerService.listTemplatesAdmin(
      {
        page: page ? parseInt(page, 10) : 1,
        pageSize: pageSize ? parseInt(pageSize, 10) : 20,
        search,
        status,
      },
      user,
    );
  }

  @Get('templates/:id')
  @ApiOperation({ summary: 'Get template detail including unpublished (admin)' })
  getTemplateDetailAdmin(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.getTemplateDetailAdmin(id, user);
  }

  @Delete('templates/:id')
  @ApiOperation({ summary: 'Delete a template (admin)' })
  deleteTemplate(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.deleteTemplate(id, user);
  }

  @Patch('templates/:id')
  @ApiOperation({ summary: 'Update template information (admin, PATCH alias for PUT)' })
  patchTemplate(
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.updateTemplate(id, dto, user);
  }

  @Patch('templates/:id/status')
  @ApiOperation({ summary: 'Update template publish status (admin, alias for publish)' })
  updateTemplateStatus(
    @Param('id') id: string,
    @Body() body: { published?: boolean; status?: string },
    @CurrentUser() user: any,
  ) {
    const published =
      body.published !== undefined
        ? body.published
        : body.status === 'published';
    return this.customizerService.publishTemplate(id, published, user);
  }

  // === Model Upload (TASK-046: File Validation) ===
  // Validates: GLB files only, max 50MB

  @Post('templates/:id/model')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }),
    new FileValidationInterceptor(),
  )
  @ValidateFile('model')
  @ApiOperation({ summary: 'Upload GLB 3D model file for a template (admin, GLB only, max 50MB)' })
  uploadModel(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.uploadModel(id, file, user);
  }

  // === UV Region Management (TASK-006) — Admin Only ===

  @Post('templates/:id/regions')
  @ApiOperation({ summary: 'Batch set UV regions for a template (admin)' })
  setRegions(
    @Param('id') templateId: string,
    @Body() dto: SetRegionsDto,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.setRegions(templateId, dto, user);
  }

  @Put('templates/:id/regions/:regionId')
  @ApiOperation({ summary: 'Update a single UV region (admin)' })
  updateRegion(
    @Param('id') templateId: string,
    @Param('regionId') regionId: string,
    @Body() dto: UpdateRegionDto,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.updateRegion(templateId, regionId, dto, user);
  }

  // === Material Management (TASK-007) — Admin Only ===

  @Post('templates/:id/materials')
  @ApiOperation({ summary: 'Add a material option to a template (admin)' })
  addMaterial(
    @Param('id') templateId: string,
    @Body() dto: CreateMaterialDto,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.addMaterial(templateId, dto, user);
  }

  @Put('templates/:id/materials/:materialId')
  @ApiOperation({ summary: 'Update a material option (admin)' })
  updateMaterial(
    @Param('id') templateId: string,
    @Param('materialId') materialId: string,
    @Body() dto: UpdateMaterialDto,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.updateMaterial(templateId, materialId, dto, user);
  }

  @Delete('templates/:id/materials/:materialId')
  @ApiOperation({ summary: 'Delete a material option (admin)' })
  deleteMaterial(
    @Param('id') templateId: string,
    @Param('materialId') materialId: string,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.deleteMaterial(templateId, materialId, user);
  }

  // === Logo Effect Management (TASK-007) — Admin Only ===

  @Post('templates/:id/effects')
  @ApiOperation({ summary: 'Add a logo effect option to a template (admin)' })
  addLogoEffect(
    @Param('id') templateId: string,
    @Body() dto: CreateLogoEffectDto,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.addLogoEffect(templateId, dto, user);
  }

  @Put('templates/:id/effects/:effectId')
  @ApiOperation({ summary: 'Update a logo effect option (admin)' })
  updateLogoEffect(
    @Param('id') templateId: string,
    @Param('effectId') effectId: string,
    @Body() dto: UpdateLogoEffectDto,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.updateLogoEffect(templateId, effectId, dto, user);
  }

  @Delete('templates/:id/effects/:effectId')
  @ApiOperation({ summary: 'Delete a logo effect option (admin)' })
  deleteLogoEffect(
    @Param('id') templateId: string,
    @Param('effectId') effectId: string,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.deleteLogoEffect(templateId, effectId, user);
  }

  // === Design Management (Admin) ===

  @Get('designs')
  @ApiOperation({ summary: 'List all designs (admin)' })
  listDesigns(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('templateId') templateId?: string,
    @CurrentUser() user?: any,
  ) {
    return this.customizerService.listDesigns(
      {
        page: page ? parseInt(page, 10) : 1,
        pageSize: pageSize ? parseInt(pageSize, 10) : 20,
        status,
        search,
        templateId,
      },
      user,
    );
  }

  @Get('designs/:id')
  @ApiOperation({ summary: 'Get design detail by database ID (admin)' })
  getDesignDetailById(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.getDesignDetailById(id, user);
  }

  @Patch('designs/:id/status')
  @ApiOperation({ summary: 'Update design status (admin)' })
  updateDesignStatus(
    @Param('id') id: string,
    @Body() body: { status: string },
    @CurrentUser() user: any,
  ) {
    return this.customizerService.updateDesignStatus(id, body.status, user);
  }

  // === Inquiry Management (TASK-009) — Admin Only ===

  @Get('inquiries')
  @ApiOperation({ summary: 'List customizer inquiries (admin)' })
  getInquiries(@Query() query: QueryInquiriesDto, @CurrentUser() user: any) {
    return this.customizerService.getInquiries(query, user);
  }

  @Get('inquiries/:id')
  @ApiOperation({ summary: 'Get inquiry detail (admin)' })
  getInquiryDetail(@Param('id') id: string, @CurrentUser() user: any) {
    return this.customizerService.getInquiryDetail(id, user);
  }

  @Patch('inquiries/:id/status')
  @ApiOperation({ summary: 'Update inquiry status (admin)' })
  updateInquiryStatus(
    @Param('id') id: string,
    @Body() body: { status: string },
    @CurrentUser() user: any,
  ) {
    return this.customizerService.updateInquiryStatus(id, body.status, user);
  }

  // === CRM Integration (TASK-047) — Admin Only ===

  @Get('leads/:leadId/designs')
  @ApiOperation({ summary: 'Get customizer designs linked to a CRM lead (admin)' })
  getDesignsByLeadId(
    @Param('leadId') leadId: string,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.getDesignsByLeadId(leadId, user);
  }

  // === Quote Conversion (TASK-010) — Admin Only ===

  @Post('inquiries/:id/quote')
  @ApiOperation({ summary: 'Convert an inquiry to a quote (admin)' })
  convertToQuote(@Param('id') inquiryId: string, @CurrentUser() user: any) {
    return this.customizerService.convertToQuote(inquiryId, user);
  }

  @Post('inquiries/:id/convert-to-quote')
  @ApiOperation({ summary: 'Convert an inquiry to a quote (admin, alias)' })
  convertToQuoteAlias(
    @Param('id') inquiryId: string,
    @CurrentUser() user: any,
  ) {
    return this.customizerService.convertToQuote(inquiryId, user);
  }
}
