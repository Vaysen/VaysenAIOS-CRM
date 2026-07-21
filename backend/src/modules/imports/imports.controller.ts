import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Res,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { Response } from 'express';
import { ImportsService } from './imports.service';
import { PreviewImportDto } from './dto/preview-import.dto';
import { ConfirmImportDto } from './dto/confirm-import.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Imports')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('imports')
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @Post('upload')
  @ApiOperation({ summary: 'Upload CSV/Excel file for import' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 201, description: 'File parsed successfully' })
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  }))
  upload(@UploadedFile() file: Express.Multer.File) {
    return this.importsService.upload(file);
  }

  @Post('preview')
  @ApiOperation({ summary: 'Preview import with field mapping' })
  @ApiResponse({ status: 201, description: 'Preview with validation errors' })
  preview(@Body() dto: PreviewImportDto) {
    return this.importsService.preview(dto.parseToken, dto.fieldMapping);
  }

  @Post('ai-mapping')
  @ApiOperation({ summary: 'Use AI to infer import field mapping' })
  @ApiResponse({ status: 201, description: 'AI field mapping returned' })
  aiMapping(@Body() dto: { parseToken: string }) {
    return this.importsService.aiMapping(dto.parseToken);
  }

  @Post('confirm')
  @ApiOperation({ summary: 'Confirm and execute import' })
  @ApiResponse({ status: 201, description: 'Import executed' })
  confirm(@Body() dto: ConfirmImportDto, @CurrentUser() user: any) {
    return this.importsService.confirm(dto.parseToken, dto.fieldMapping, user);
  }

  @Get()
  @ApiOperation({ summary: 'List import history' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAll(
    @CurrentUser() user: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.importsService.findAll(user, { page, limit });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get import detail' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.importsService.findOne(id, user);
  }

  @Get(':id/errors')
  @ApiOperation({ summary: 'Get import error records' })
  getErrors(@Param('id') id: string, @CurrentUser() user: any) {
    return this.importsService.getErrors(id, user);
  }

  @Get(':id/download-errors')
  @ApiOperation({ summary: 'Download import errors as CSV' })
  async downloadErrors(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Res() res: Response,
  ) {
    const { content, fileName } = await this.importsService.downloadErrors(id, user);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(content);
  }
}
