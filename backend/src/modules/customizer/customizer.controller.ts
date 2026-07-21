import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Query,
  Body,
  Req,
  Res,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { CustomizerService } from './customizer.service';
import { Public } from '../../common/decorators/public.decorator';
import { TemplateQueryDto } from './dto/template-query.dto';
import { SaveDesignDto, UpdateDesignDto } from './dto/save-design.dto';
import { SubmitInquiryDto } from './dto/inquiry.dto';
import {
  RateLimitInterceptor,
  RateLimit,
} from './rate-limit.interceptor';
import {
  FileValidationInterceptor,
  ValidateFile,
} from './file-validation.interceptor';
import {
  CUSTOMIZER_IMAGE_MAX_BYTES,
  CUSTOMIZER_PDF_MAX_BYTES,
  validateCustomizerUpload,
} from './customizer-upload-security';

/* ========================================
   Customizer Public Controller (TASK-046)
   - All public endpoints use @Public() decorator
   - Inquiry submission has rate limiting (5 req/min)
   - Model download is public with Range support
   - Image processing endpoints proxy to Python microservice (TASK-014)
   ======================================== */

const IMAGE_UPLOAD_LIMITS = {
  storage: memoryStorage(),
  limits: { fileSize: CUSTOMIZER_IMAGE_MAX_BYTES },
};
const PDF_UPLOAD_LIMITS = {
  storage: memoryStorage(),
  limits: { fileSize: CUSTOMIZER_PDF_MAX_BYTES },
};

@ApiTags('Customizer')
@Controller('customizer')
export class CustomizerController {
  constructor(private readonly customizerService: CustomizerService) {}

  // === Templates (TASK-004) — Public ===

  @Public()
  @Get('templates')
  @ApiOperation({ summary: 'List published customizer templates' })
  getTemplates(@Query() query: TemplateQueryDto) {
    return this.customizerService.getTemplates(query);
  }

  @Public()
  @Get('templates/:id')
  @ApiOperation({ summary: 'Get template detail with regions, materials, effects' })
  getTemplateDetail(@Param('id') id: string) {
    return this.customizerService.getTemplateDetail(id);
  }

  @Public()
  @Get('templates/:id/model')
  @ApiOperation({ summary: 'Download 3D GLB model file (supports Range requests)' })
  getModelFile(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.customizerService.getModelFile(id, req, res);
  }

  // === Designs (TASK-008) — Public ===

  @Public()
  @Post('designs')
  @ApiOperation({ summary: 'Save a customizer design (generates shareCode)' })
  saveDesign(@Body() dto: SaveDesignDto) {
    return this.customizerService.saveDesign(dto);
  }

  @Public()
  @Get('designs/:code')
  @ApiOperation({ summary: 'Get design by shareCode (public)' })
  getDesign(@Param('code') code: string) {
    return this.customizerService.getDesign(code);
  }

  @Public()
  @Put('designs/:code')
  @ApiOperation({ summary: 'Update design by shareCode' })
  updateDesign(
    @Param('code') code: string,
    @Body() dto: UpdateDesignDto,
  ) {
    return this.customizerService.updateDesign(code, dto);
  }

  // === Inquiries (TASK-009) — Public with Rate Limiting (TASK-046) ===

  @Public()
  @Post('inquiries')
  @UseInterceptors(RateLimitInterceptor)
  @RateLimit(5, 60_000) // 5 requests per minute per IP
  @ApiOperation({ summary: 'Submit an inquiry for a design (rate limited: 5/min)' })
  submitInquiry(@Body() dto: SubmitInquiryDto) {
    return this.customizerService.submitInquiry(dto);
  }

  // === Image Processing (TASK-014) — authenticated, rate-limited proxy ===

  @Post('image/remove-bg')
  @UseInterceptors(RateLimitInterceptor, FileInterceptor('file', IMAGE_UPLOAD_LIMITS))
  @RateLimit(10, 60_000)
  @ApiOperation({ summary: 'Remove image background (proxies to Python rembg microservice)' })
  removeBackground(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    validateCustomizerUpload(file, 'image');
    return this.customizerService.removeBackground(file);
  }

  @Post('image/pdf-to-images')
  @UseInterceptors(RateLimitInterceptor, FileInterceptor('file', PDF_UPLOAD_LIMITS))
  @RateLimit(5, 60_000)
  @ApiOperation({ summary: 'Convert PDF to images (proxies to Python PyMuPDF microservice)' })
  pdfToImages(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    validateCustomizerUpload(file, 'pdf');
    return this.customizerService.pdfToImages(file);
  }
}
