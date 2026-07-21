import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  ServiceUnavailableException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CustomizerPricingService } from './customizer-pricing.service';
import { TemplateQueryDto } from './dto/template-query.dto';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { SetRegionsDto } from './dto/set-regions.dto';
import { UpdateRegionDto } from './dto/update-region.dto';
import { CreateMaterialDto, UpdateMaterialDto } from './dto/material.dto';
import { CreateLogoEffectDto, UpdateLogoEffectDto } from './dto/effect.dto';
import { SaveDesignDto, UpdateDesignDto } from './dto/save-design.dto';
import { SubmitInquiryDto, QueryInquiriesDto } from './dto/inquiry.dto';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { validateCustomizerUpload } from './customizer-upload-security';
import { Request, Response } from 'express';

// TASK-014: Python image-processor microservice URL
const IMAGE_PROCESSOR_URL =
  process.env.IMAGE_PROCESSOR_URL || 'http://python-service:5000';

@Injectable()
export class CustomizerService implements OnModuleInit {
  private readonly logger = new Logger(CustomizerService.name);
  private readonly assetsDir = path.resolve(process.cwd(), '.customizer-assets', 'models');
  private readonly imageAssetsDir = path.resolve(process.cwd(), '.customizer-assets');

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: CustomizerPricingService,
  ) {}

  onModuleInit() {
    if (!fs.existsSync(this.assetsDir)) {
      fs.mkdirSync(this.assetsDir, { recursive: true });
      this.logger.log(`Created assets directory: ${this.assetsDir}`);
    }
  }

  // ===========================================================================
  // Template Query (TASK-004) — Public
  // ===========================================================================

  async getTemplates(query: TemplateQueryDto) {
    const { productId, page = 1, pageSize = 20 } = query;
    const skip = (page - 1) * pageSize;

    const where = {
      isPublished: true,
      ...(productId ? { productId } : {}),
    };

    const [templates, total] = await Promise.all([
      this.prisma.customizerTemplate.findMany({
        where,
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          basePrice: true,
          currency: true,
          moq: true,
          leadTimeDays: true,
          sortOrder: true,
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.customizerTemplate.count({ where }),
    ]);

    return {
      items: templates.map((t) => ({
        ...t,
        basePrice: Number(t.basePrice),
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getTemplateDetail(id: string) {
    const template = await this.prisma.customizerTemplate.findUnique({
      where: { id },
      include: {
        regions: {
          orderBy: { sortOrder: 'asc' },
        },
        materials: {
          orderBy: { sortOrder: 'asc' },
        },
        logoEffects: {
          orderBy: { sortOrder: 'asc' },
        },
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
          },
        },
      },
    });

    if (!template || !template.isPublished) {
      throw new NotFoundException(`Template ${id} not found`);
    }

    return {
      ...template,
      basePrice: Number(template.basePrice),
      modelUrl: `/api/customizer/templates/${id}/model`,
      regions: template.regions,
      materials: template.materials.map((m) => ({
        ...m,
        priceModifier: Number(m.priceModifier),
      })),
      logoEffects: template.logoEffects.map((e) => ({
        ...e,
        pricePerColor: Number(e.pricePerColor),
      })),
    };
  }

  async getModelFile(id: string, req: Request, res: Response) {
    const template = await this.prisma.customizerTemplate.findUnique({
      where: { id },
      select: { modelUrl: true, isPublished: true },
    });

    if (!template || !template.isPublished) {
      throw new NotFoundException(`Template ${id} not found`);
    }

    if (!template.modelUrl) {
      throw new NotFoundException('Model file not found');
    }

    const filePath = path.resolve(template.modelUrl);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('Model file not found');
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Accept-Ranges', 'bytes');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', end - start + 1);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', fileSize);
      fs.createReadStream(filePath).pipe(res);
    }
  }

  // ===========================================================================
  // Template Management (TASK-005) — Admin
  // ===========================================================================

  async createTemplate(dto: CreateTemplateDto, user: any) {
    const companyId = user?.companies?.[0]?.id;
    if (!companyId) {
      throw new ForbiddenException('No company access');
    }

    // Check slug uniqueness
    const existing = await this.prisma.customizerTemplate.findUnique({
      where: { slug: dto.slug },
    });
    if (existing) {
      throw new ConflictException(`Slug "${dto.slug}" already exists`);
    }

    // Check productId exists if provided
    if (dto.productId) {
      const product = await this.prisma.product.findUnique({
        where: { id: dto.productId },
      });
      if (!product) {
        throw new NotFoundException(`Product ${dto.productId} not found`);
      }
    }

    const template = await this.prisma.customizerTemplate.create({
      data: {
        companyId,
        productId: dto.productId || null,
        name: dto.name,
        slug: dto.slug,
        description: dto.description || null,
        modelUrl: '',
        modelFormat: 'glb',
        textureSize: dto.textureSize ?? 2048,
        unfoldLayout: dto.unfoldLayout ?? {},
        basePrice: dto.basePrice,
        currency: dto.currency || 'USD',
        moq: dto.moq ?? 10000,
        leadTimeDays: dto.leadTimeDays ?? 20,
        isPublished: false,
        sortOrder: dto.sortOrder ?? 0,
      },
    });

    return {
      ...template,
      basePrice: Number(template.basePrice),
    };
  }

  async updateTemplate(id: string, dto: UpdateTemplateDto, user: any) {
    const template = await this.prisma.customizerTemplate.findUnique({
      where: { id },
    });
    if (!template) {
      throw new NotFoundException(`Template ${id} not found`);
    }

    this.ensureCompanyAccess(user, template.companyId);

    // If updating slug, check uniqueness
    if (dto.slug && dto.slug !== template.slug) {
      const existing = await this.prisma.customizerTemplate.findUnique({
        where: { slug: dto.slug },
      });
      if (existing) {
        throw new ConflictException(`Slug "${dto.slug}" already exists`);
      }
    }

    // If updating productId, check it exists
    if (dto.productId) {
      const product = await this.prisma.product.findUnique({
        where: { id: dto.productId },
      });
      if (!product) {
        throw new NotFoundException(`Product ${dto.productId} not found`);
      }
    }

    const updated = await this.prisma.customizerTemplate.update({
      where: { id },
      data: {
        ...(dto.productId !== undefined && { productId: dto.productId || null }),
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.slug !== undefined && { slug: dto.slug }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.basePrice !== undefined && { basePrice: dto.basePrice }),
        ...(dto.currency !== undefined && { currency: dto.currency }),
        ...(dto.moq !== undefined && { moq: dto.moq }),
        ...(dto.leadTimeDays !== undefined && { leadTimeDays: dto.leadTimeDays }),
        ...(dto.textureSize !== undefined && { textureSize: dto.textureSize }),
        ...(dto.unfoldLayout !== undefined && { unfoldLayout: dto.unfoldLayout }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      },
    });

    return {
      ...updated,
      basePrice: Number(updated.basePrice),
    };
  }

  async publishTemplate(id: string, isPublished: boolean, user: any) {
    const template = await this.prisma.customizerTemplate.findUnique({
      where: { id },
      select: { id: true, isPublished: true, modelUrl: true, name: true, companyId: true },
    });

    if (!template) {
      throw new NotFoundException(`Template ${id} not found`);
    }

    this.ensureCompanyAccess(user, template.companyId);

    // Publishing requires a model file
    if (isPublished && !template.modelUrl) {
      throw new BadRequestException('Cannot publish template without a model file');
    }

    const updated = await this.prisma.customizerTemplate.update({
      where: { id },
      data: { isPublished },
    });

    return {
      id: updated.id,
      isPublished: updated.isPublished,
    };
  }

  async uploadModel(id: string, file: Express.Multer.File, user: any) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    const template = await this.prisma.customizerTemplate.findUnique({
      where: { id },
      select: { id: true, modelUrl: true, companyId: true },
    });

    if (!template) {
      throw new NotFoundException(`Template ${id} not found`);
    }

    this.ensureCompanyAccess(user, template.companyId);

    // Delete old model file if it exists
    if (template.modelUrl) {
      const oldPath = path.resolve(template.modelUrl);
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }

    // Store relative path
    const modelPath = path.join('.customizer-assets', 'models', file.filename);

    const updated = await this.prisma.customizerTemplate.update({
      where: { id },
      data: { modelUrl: modelPath },
    });

    return {
      id: updated.id,
      modelUrl: `/api/customizer/templates/${id}/model`,
      filename: file.filename,
      size: file.size,
    };
  }

  // ===========================================================================
  // UV Region Management (TASK-006) — Admin
  // ===========================================================================

  async setRegions(templateId: string, dto: SetRegionsDto, user: any) {
    const template = await this.prisma.customizerTemplate.findUnique({
      where: { id: templateId },
      select: { id: true, companyId: true },
    });
    if (!template) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }

    this.ensureCompanyAccess(user, template.companyId);

    // Validate no duplicate regionIds
    const regionIds = dto.regions.map((r) => r.regionId);
    const uniqueIds = new Set(regionIds);
    if (uniqueIds.size !== regionIds.length) {
      throw new BadRequestException('Duplicate regionId in request');
    }

    // Transaction: delete old regions, create new ones
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.customizerRegion.deleteMany({
        where: { templateId },
      });

      const created = await Promise.all(
        dto.regions.map((region, index) =>
          tx.customizerRegion.create({
            data: {
              templateId,
              regionId: region.regionId,
              label: region.label,
              uvX: Math.round(region.uvX),
              uvY: Math.round(region.uvY),
              uvW: Math.round(region.uvW),
              uvH: Math.round(region.uvH),
              unfoldX: region.unfoldX,
              unfoldY: region.unfoldY,
              unfoldW: region.unfoldW,
              unfoldH: region.unfoldH,
              isEditable: region.isEditable ?? true,
              sortOrder: region.sortOrder ?? index,
            },
          }),
        ),
      );

      return created;
    });

    return {
      templateId,
      regions: result,
      count: result.length,
    };
  }

  async updateRegion(templateId: string, regionId: string, dto: UpdateRegionDto, user: any) {
    const template = await this.prisma.customizerTemplate.findUnique({
      where: { id: templateId },
      select: { id: true, companyId: true },
    });
    if (!template) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }

    this.ensureCompanyAccess(user, template.companyId);

    // Find region by templateId + regionId (no compound unique in schema)
    const region = await this.prisma.customizerRegion.findFirst({
      where: { templateId, regionId },
    });

    if (!region) {
      throw new NotFoundException(
        `Region ${regionId} not found in template ${templateId}`,
      );
    }

    const updated = await this.prisma.customizerRegion.update({
      where: { id: region.id },
      data: {
        ...(dto.label !== undefined && { label: dto.label }),
        ...(dto.uvX !== undefined && { uvX: Math.round(dto.uvX) }),
        ...(dto.uvY !== undefined && { uvY: Math.round(dto.uvY) }),
        ...(dto.uvW !== undefined && { uvW: Math.round(dto.uvW) }),
        ...(dto.uvH !== undefined && { uvH: Math.round(dto.uvH) }),
        ...(dto.unfoldX !== undefined && { unfoldX: dto.unfoldX }),
        ...(dto.unfoldY !== undefined && { unfoldY: dto.unfoldY }),
        ...(dto.unfoldW !== undefined && { unfoldW: dto.unfoldW }),
        ...(dto.unfoldH !== undefined && { unfoldH: dto.unfoldH }),
        ...(dto.isEditable !== undefined && { isEditable: dto.isEditable }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      },
    });

    return updated;
  }

  // ===========================================================================
  // Material Management (TASK-007) — Admin
  // ===========================================================================

  async addMaterial(templateId: string, dto: CreateMaterialDto, user: any) {
    const template = await this.prisma.customizerTemplate.findUnique({
      where: { id: templateId },
      select: { id: true, companyId: true },
    });
    if (!template) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }

    this.ensureCompanyAccess(user, template.companyId);

    // Check type uniqueness within template
    const existing = await this.prisma.customizerMaterial.findFirst({
      where: { templateId, type: dto.type },
    });
    if (existing) {
      throw new ConflictException(`Material type "${dto.type}" already exists in this template`);
    }

    const material = await this.prisma.customizerMaterial.create({
      data: {
        templateId,
        name: dto.name,
        type: dto.type,
        colorHex: dto.colorHex || '#ffffff',
        textureUrl: dto.textureUrl || null,
        priceModifier: dto.priceModifier,
        sortOrder: dto.sortOrder ?? 0,
      },
    });

    return {
      ...material,
      priceModifier: Number(material.priceModifier),
    };
  }

  async updateMaterial(templateId: string, materialId: string, dto: UpdateMaterialDto, user: any) {
    const template = await this.prisma.customizerTemplate.findUnique({
      where: { id: templateId },
      select: { id: true, companyId: true },
    });
    if (!template) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }

    this.ensureCompanyAccess(user, template.companyId);

    const material = await this.prisma.customizerMaterial.findFirst({
      where: { id: materialId, templateId },
    });
    if (!material) {
      throw new NotFoundException(`Material ${materialId} not found`);
    }

    // If type is changing, check uniqueness
    if (dto.type && dto.type !== material.type) {
      const existing = await this.prisma.customizerMaterial.findFirst({
        where: { templateId, type: dto.type },
      });
      if (existing) {
        throw new ConflictException(`Material type "${dto.type}" already exists in this template`);
      }
    }

    const updated = await this.prisma.customizerMaterial.update({
      where: { id: materialId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.colorHex !== undefined && { colorHex: dto.colorHex }),
        ...(dto.textureUrl !== undefined && { textureUrl: dto.textureUrl }),
        ...(dto.priceModifier !== undefined && { priceModifier: dto.priceModifier }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      },
    });

    return {
      ...updated,
      priceModifier: Number(updated.priceModifier),
    };
  }

  async deleteMaterial(templateId: string, materialId: string, user: any) {
    const template = await this.prisma.customizerTemplate.findUnique({
      where: { id: templateId },
      select: { id: true, companyId: true },
    });
    if (!template) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }

    this.ensureCompanyAccess(user, template.companyId);

    const material = await this.prisma.customizerMaterial.findFirst({
      where: { id: materialId, templateId },
    });
    if (!material) {
      throw new NotFoundException(`Material ${materialId} not found`);
    }

    await this.prisma.customizerMaterial.delete({
      where: { id: materialId },
    });

    return { id: materialId, deleted: true };
  }

  // ===========================================================================
  // Logo Effect Management (TASK-007) — Admin
  // ===========================================================================

  async addLogoEffect(templateId: string, dto: CreateLogoEffectDto, user: any) {
    const template = await this.prisma.customizerTemplate.findUnique({
      where: { id: templateId },
      select: { id: true, companyId: true },
    });
    if (!template) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }

    this.ensureCompanyAccess(user, template.companyId);

    // Check name uniqueness within template
    const existing = await this.prisma.customizerLogoEffect.findFirst({
      where: { templateId, name: dto.name },
    });
    if (existing) {
      throw new ConflictException(`Effect name "${dto.name}" already exists in this template`);
    }

    const effect = await this.prisma.customizerLogoEffect.create({
      data: {
        templateId,
        name: dto.name,
        label: dto.label,
        previewUrl: dto.previewUrl || null,
        pricePerColor: dto.pricePerColor,
        minColors: dto.minColors ?? 1,
        sortOrder: dto.sortOrder ?? 0,
      },
    });

    return {
      ...effect,
      pricePerColor: Number(effect.pricePerColor),
    };
  }

  async updateLogoEffect(templateId: string, effectId: string, dto: UpdateLogoEffectDto, user: any) {
    const template = await this.prisma.customizerTemplate.findUnique({
      where: { id: templateId },
      select: { id: true, companyId: true },
    });
    if (!template) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }

    this.ensureCompanyAccess(user, template.companyId);

    const effect = await this.prisma.customizerLogoEffect.findFirst({
      where: { id: effectId, templateId },
    });
    if (!effect) {
      throw new NotFoundException(`Effect ${effectId} not found`);
    }

    // If name is changing, check uniqueness
    if (dto.name && dto.name !== effect.name) {
      const existing = await this.prisma.customizerLogoEffect.findFirst({
        where: { templateId, name: dto.name },
      });
      if (existing) {
        throw new ConflictException(`Effect name "${dto.name}" already exists in this template`);
      }
    }

    const updated = await this.prisma.customizerLogoEffect.update({
      where: { id: effectId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.label !== undefined && { label: dto.label }),
        ...(dto.previewUrl !== undefined && { previewUrl: dto.previewUrl }),
        ...(dto.pricePerColor !== undefined && { pricePerColor: dto.pricePerColor }),
        ...(dto.minColors !== undefined && { minColors: dto.minColors }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      },
    });

    return {
      ...updated,
      pricePerColor: Number(updated.pricePerColor),
    };
  }

  async deleteLogoEffect(templateId: string, effectId: string, user: any) {
    const template = await this.prisma.customizerTemplate.findUnique({
      where: { id: templateId },
      select: { id: true, companyId: true },
    });
    if (!template) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }

    this.ensureCompanyAccess(user, template.companyId);

    const effect = await this.prisma.customizerLogoEffect.findFirst({
      where: { id: effectId, templateId },
    });
    if (!effect) {
      throw new NotFoundException(`Effect ${effectId} not found`);
    }

    await this.prisma.customizerLogoEffect.delete({
      where: { id: effectId },
    });

    return { id: effectId, deleted: true };
  }

  // ===========================================================================
  // Design Management (TASK-008) — Public
  // ===========================================================================

  private generateShareCode(): string {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
  }

  private async generateUniqueShareCode(): Promise<string> {
    let code: string;
    let attempts = 0;
    const maxAttempts = 10;

    do {
      code = this.generateShareCode();
      const existing = await this.prisma.customizerDesign.findUnique({
        where: { shareCode: code },
      });
      if (!existing) {
        return code;
      }
      attempts++;
    } while (attempts < maxAttempts);

    throw new InternalServerErrorException('Failed to generate unique share code');
  }

  async saveDesign(dto: SaveDesignDto) {
    // Validate template exists and is published
    const template = await this.prisma.customizerTemplate.findUnique({
      where: { id: dto.templateId },
      select: { id: true, isPublished: true, companyId: true },
    });
    if (!template) {
      throw new NotFoundException(`Template ${dto.templateId} not found`);
    }
    if (!template.isPublished) {
      throw new BadRequestException('Template is not published');
    }

    const shareCode = await this.generateUniqueShareCode();

    const design = await this.prisma.customizerDesign.create({
      data: {
        companyId: template.companyId,
        templateId: dto.templateId,
        shareCode,
        config: dto.config,
        thumbnailUrl: dto.thumbnailUrl || null,
        customerName: dto.customerName || null,
        customerEmail: dto.customerEmail || null,
        customerPhone: dto.customerPhone || null,
        status: 'draft',
      },
      include: {
        template: {
          select: {
            id: true,
            name: true,
            slug: true,
            basePrice: true,
            currency: true,
            moq: true,
          },
        },
      },
    });

    return {
      id: design.id,
      shareCode: design.shareCode,
      templateId: design.templateId,
      config: design.config,
      thumbnailUrl: design.thumbnailUrl,
      customerName: design.customerName,
      createdAt: design.createdAt,
      updatedAt: design.updatedAt,
      template: {
        ...design.template,
        basePrice: Number(design.template.basePrice),
      },
    };
  }

  async getDesign(code: string) {
    const design = await this.prisma.customizerDesign.findUnique({
      where: { shareCode: code.toUpperCase() },
      include: {
        template: {
          select: {
            id: true,
            name: true,
            slug: true,
            basePrice: true,
            currency: true,
            moq: true,
            isPublished: true,
            regions: { orderBy: { sortOrder: 'asc' } },
            materials: { orderBy: { sortOrder: 'asc' } },
            logoEffects: { orderBy: { sortOrder: 'asc' } },
          },
        },
      },
    });

    if (!design) {
      throw new NotFoundException(`Design with code ${code} not found`);
    }

    return {
      id: design.id,
      shareCode: design.shareCode,
      config: design.config,
      thumbnailUrl: design.thumbnailUrl,
      customerName: design.customerName,
      createdAt: design.createdAt,
      updatedAt: design.updatedAt,
      template: {
        ...design.template,
        basePrice: Number(design.template.basePrice),
        materials: design.template.materials.map((m) => ({
          ...m,
          priceModifier: Number(m.priceModifier),
        })),
        logoEffects: design.template.logoEffects.map((e) => ({
          ...e,
          pricePerColor: Number(e.pricePerColor),
        })),
      },
    };
  }

  async updateDesign(code: string, dto: UpdateDesignDto) {
    const design = await this.prisma.customizerDesign.findUnique({
      where: { shareCode: code.toUpperCase() },
      select: { id: true },
    });

    if (!design) {
      throw new NotFoundException(`Design with code ${code} not found`);
    }

    const updated = await this.prisma.customizerDesign.update({
      where: { id: design.id },
      data: {
        ...(dto.config !== undefined && { config: dto.config }),
        ...(dto.thumbnailUrl !== undefined && { thumbnailUrl: dto.thumbnailUrl }),
        ...(dto.customerName !== undefined && { customerName: dto.customerName }),
        ...(dto.customerEmail !== undefined && { customerEmail: dto.customerEmail }),
        ...(dto.customerPhone !== undefined && { customerPhone: dto.customerPhone }),
      },
    });

    return {
      id: updated.id,
      shareCode: updated.shareCode,
      config: updated.config,
      thumbnailUrl: updated.thumbnailUrl,
      updatedAt: updated.updatedAt,
    };
  }

  // ===========================================================================
  // Inquiry Management (TASK-009/010) — Public submit, Admin manage
  // ===========================================================================

  async submitInquiry(dto: SubmitInquiryDto) {
    // Get design with template for pricing
    const design = await this.prisma.customizerDesign.findUnique({
      where: { id: dto.designId },
      include: {
        template: {
          include: {
            materials: true,
            logoEffects: true,
          },
        },
      },
    });

    if (!design) {
      throw new NotFoundException(`Design ${dto.designId} not found`);
    }

    const config = design.config as any;
    const template = design.template;

    // Validate quantity meets MOQ
    if (dto.quantity < template.moq) {
      throw new BadRequestException(
        `Quantity ${dto.quantity} is below MOQ of ${template.moq}`,
      );
    }

    // Look up material surcharge
    let materialSurcharge = 0;
    if (config.materialId) {
      const material = template.materials.find((m) => m.id === config.materialId);
      if (material) {
        materialSurcharge = Number(material.priceModifier);
      }
    }

    // Look up logo effect surcharge
    let logoEffectSurcharge = 0;
    if (config.logoEffectId) {
      const effect = template.logoEffects.find((e) => e.id === config.logoEffectId);
      if (effect) {
        const numColors = Math.max(
          config.logoColors || config.numColors || effect.minColors || 1,
          effect.minColors || 1,
        );
        logoEffectSurcharge = Number(effect.pricePerColor) * numColors;
      }
    }

    // Calculate pricing
    const pricing = this.pricingService.calculate(
      {
        basePrice: Number(template.basePrice),
        moq: template.moq,
        quantity: dto.quantity,
        materialSurcharge,
        logoEffectSurcharge,
      },
      template.currency,
    );

    // Create inquiry
    const inquiry = await this.prisma.customizerInquiry.create({
      data: {
        designId: dto.designId,
        quantity: dto.quantity,
        unitPrice: pricing.unitPrice,
        totalPrice: pricing.totalPrice,
        currency: template.currency,
        status: 'new',
        notes: dto.notes || null,
      },
      include: {
        design: {
          select: {
            id: true,
            shareCode: true,
            customerName: true,
            customerEmail: true,
            customerPhone: true,
            template: {
              select: { id: true, name: true, slug: true },
            },
          },
        },
      },
    });

    // TASK-047: CRM Integration — auto-create / link a Lead based on customerEmail.
    // If the design is not yet linked to a Lead, look up an existing Lead by email.
    // If none exists, create a new Lead with source "packaging-customizer".
    let leadId = design.leadId;
    let leadCreated = false;
    if (!leadId && dto.customerEmail) {
      const existingLead = await this.prisma.lead.findFirst({
        where: { contactEmail: dto.customerEmail, companyId: design.companyId },
        select: { id: true },
      });

      if (existingLead) {
        leadId = existingLead.id;
        this.logger.log(
          `Linked existing Lead ${leadId} to design ${dto.designId} (${dto.customerEmail})`,
        );
      } else {
        const newLead = await this.prisma.lead.create({
          data: {
            companyId: design.companyId,
            leadName: dto.customerName || null,
            companyName: dto.company || dto.customerName || 'Unknown',
            contactName: dto.customerName || null,
            contactEmail: dto.customerEmail,
            contactPhone: dto.customerPhone || null,
            sourceType: 'packaging-customizer',
            sourceUrl: `design:${design.shareCode}`,
            status: 'new',
            notes:
              `Auto-created from packaging customizer inquiry. ` +
              `Design: ${design.shareCode}, Quantity: ${dto.quantity}, ` +
              `Template: ${template.name}.`,
          },
        });
        leadId = newLead.id;
        leadCreated = true;
        this.logger.log(
          `Auto-created Lead ${leadId} for ${dto.customerEmail} from inquiry`,
        );
      }
    }

    // Update design status to submitted, save customer contact info, and link Lead (TASK-046/047)
    await this.prisma.customizerDesign.update({
      where: { id: dto.designId },
      data: {
        status: 'submitted',
        submittedAt: new Date(),
        // Save customer contact info from inquiry DTO
        ...(dto.customerName ? { customerName: dto.customerName } : {}),
        ...(dto.customerEmail ? { customerEmail: dto.customerEmail } : {}),
        ...(dto.customerPhone ? { customerPhone: dto.customerPhone } : {}),
        // Link design to Lead (TASK-047)
        ...(leadId ? { leadId } : {}),
      },
    });

    return {
      ...inquiry,
      unitPrice: Number(inquiry.unitPrice),
      totalPrice: Number(inquiry.totalPrice),
      pricing,
      leadId: leadId || null,
      leadCreated,
    };
  }

  async getInquiries(query: QueryInquiriesDto, user: any) {
    const companyIds = user?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0) {
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize, totalPages: 0 };
    }

    const { page = 1, pageSize = 20, status, designId } = query;
    const skip = (page - 1) * pageSize;

    const where: any = {
      design: { companyId: { in: companyIds } },
    };
    if (status) where.status = status;
    if (designId) where.designId = designId;

    const [inquiries, total] = await Promise.all([
      this.prisma.customizerInquiry.findMany({
        where,
        include: {
          design: {
            select: {
              id: true,
              shareCode: true,
              customerName: true,
              customerEmail: true,
              customerPhone: true,
              template: {
                select: { id: true, name: true, slug: true },
              },
            },
          },
          quote: {
            select: { id: true, referenceNo: true, status: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.customizerInquiry.count({ where }),
    ]);

    return {
      items: inquiries.map((i) => ({
        ...i,
        unitPrice: i.unitPrice ? Number(i.unitPrice) : null,
        totalPrice: i.totalPrice ? Number(i.totalPrice) : null,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getInquiryDetail(id: string, user: any) {
    const inquiry = await this.prisma.customizerInquiry.findUnique({
      where: { id },
      include: {
        design: {
          select: {
            id: true,
            shareCode: true,
            customerName: true,
            customerEmail: true,
            customerPhone: true,
            config: true,
            thumbnailUrl: true,
            template: {
              select: {
                id: true,
                name: true,
                slug: true,
                basePrice: true,
                currency: true,
                moq: true,
                companyId: true,
              },
            },
          },
        },
        quote: {
          select: { id: true, referenceNo: true, status: true, totalAmount: true },
        },
      },
    });

    if (!inquiry) {
      throw new NotFoundException(`Inquiry ${id} not found`);
    }

    // Check company access via design's template
    this.ensureCompanyAccess(user, inquiry.design.template.companyId);

    return {
      ...inquiry,
      unitPrice: inquiry.unitPrice ? Number(inquiry.unitPrice) : null,
      totalPrice: inquiry.totalPrice ? Number(inquiry.totalPrice) : null,
      design: {
        ...inquiry.design,
        template: {
          ...inquiry.design.template,
          basePrice: Number(inquiry.design.template.basePrice),
        },
      },
      quote: inquiry.quote
        ? {
            ...inquiry.quote,
            totalAmount: Number(inquiry.quote.totalAmount),
          }
        : null,
    };
  }

  // ===========================================================================
  // CRM Integration (TASK-047) — Admin
  // ===========================================================================

  /**
   * Retrieve all customizer designs linked to a specific Lead.
   * Used by the CRM customer/lead detail page to display design history.
   */
  async getDesignsByLeadId(leadId: string, user: any) {
    // Verify the Lead exists and the user has company access
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, companyId: true, contactName: true, contactEmail: true },
    });

    if (!lead) {
      throw new NotFoundException(`Lead ${leadId} not found`);
    }

    this.ensureCompanyAccess(user, lead.companyId);

    const designs = await this.prisma.customizerDesign.findMany({
      where: { leadId },
      include: {
        template: {
          select: {
            id: true,
            name: true,
            slug: true,
            basePrice: true,
            currency: true,
            moq: true,
          },
        },
        inquiries: {
          select: {
            id: true,
            quantity: true,
            unitPrice: true,
            totalPrice: true,
            currency: true,
            status: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      leadId: lead.id,
      contactName: lead.contactName,
      contactEmail: lead.contactEmail,
      designs: designs.map((d) => ({
        id: d.id,
        shareCode: d.shareCode,
        templateId: d.templateId,
        customerName: d.customerName,
        customerEmail: d.customerEmail,
        customerPhone: d.customerPhone,
        thumbnailUrl: d.thumbnailUrl,
        status: d.status,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        submittedAt: d.submittedAt,
        template: {
          ...d.template,
          basePrice: Number(d.template.basePrice),
        },
        inquiries: d.inquiries.map((i) => ({
          ...i,
          unitPrice: i.unitPrice ? Number(i.unitPrice) : null,
          totalPrice: i.totalPrice ? Number(i.totalPrice) : null,
        })),
      })),
      total: designs.length,
    };
  }

  // ===========================================================================
  // Convert to Quote (TASK-010) — Admin
  // ===========================================================================

  async convertToQuote(inquiryId: string, user: any) {
    const inquiry = await this.prisma.customizerInquiry.findUnique({
      where: { id: inquiryId },
      include: {
        design: {
          select: {
            id: true,
            companyId: true,
            leadId: true,
            customerName: true,
            customerEmail: true,
            config: true,
            template: {
              select: {
                id: true,
                name: true,
                slug: true,
                currency: true,
                moq: true,
                leadTimeDays: true,
              },
            },
          },
        },
      },
    });

    if (!inquiry) {
      throw new NotFoundException(`Inquiry ${inquiryId} not found`);
    }

    const companyId = inquiry.design.companyId;
    this.ensureCompanyAccess(user, companyId);

    if (inquiry.quoteId) {
      throw new BadRequestException('Inquiry has already been converted to a quote');
    }

    // Generate quote reference number
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const refNo = `QT-${dateStr}-${String(Date.now()).slice(-4)}`;

    const unitPrice = Number(inquiry.unitPrice) || 0;
    const totalPrice = Number(inquiry.totalPrice) || 0;
    const config = inquiry.design.config as any;

    // Create Quote with QuoteLineItem in a transaction
    const quote = await this.prisma.$transaction(async (tx) => {
      const created = await tx.quote.create({
        data: {
          companyId,
          leadId: inquiry.design.leadId || null,
          referenceNo: refNo,
          type: 'quote',
          status: 'draft',
          assignedUserId: user.id,
          currency: inquiry.currency,
          subtotal: totalPrice,
          taxAmount: 0,
          totalAmount: totalPrice,
          notes: inquiry.notes || null,
          lineItems: {
            create: {
              productName: inquiry.design.template.name,
              quantity: inquiry.quantity,
              unit: 'pcs',
              unitPrice: unitPrice,
              totalPrice: totalPrice,
              color: config?.colorHex || null,
              notes: config?.notes || null,
              sortOrder: 0,
            },
          },
        },
        include: { lineItems: true },
      });

      // Update inquiry with quoteId
      await tx.customizerInquiry.update({
        where: { id: inquiryId },
        data: {
          quoteId: created.id,
          status: 'quoted',
        },
      });

      return created;
    });

    this.logger.log(`Quote ${refNo} created from inquiry ${inquiryId}`);

    return {
      quoteId: quote.id,
      referenceNo: refNo,
      inquiryId,
      totalAmount: Number(quote.totalAmount),
      status: quote.status,
      itemCount: quote.lineItems.length,
    };
  }

  // ===========================================================================
  // Image Processing (TASK-014) — Proxy to Python microservice
  // ===========================================================================

  /**
   * Remove background from an uploaded image by forwarding it to the
   * Python image-processor microservice (rembg / u2net).
   * Returns the URL of the saved transparent PNG.
   */
  async removeBackground(file: Express.Multer.File): Promise<{ url: string }> {
    validateCustomizerUpload(file, 'image');

    try {
      // Build multipart form data
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || 'image/png' });
      formData.append('file', blob, file.originalname || 'image.png');

      this.logger.log(
        `removeBackground: forwarding ${file.originalname} (${file.size} bytes) to image-processor`,
      );

      const response = await fetch(`${IMAGE_PROCESSOR_URL}/remove-bg`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown error');
        if (response.status === 503) {
          throw new ServiceUnavailableException(
            'Image processing service is temporarily unavailable',
          );
        }
        throw new InternalServerErrorException(
          `Image processor error (${response.status}): ${errText}`,
        );
      }

      const pngBuffer = Buffer.from(await response.arrayBuffer());
      const hash = crypto
        .createHash('sha256')
        .update(pngBuffer)
        .digest('hex')
        .substring(0, 12);
      const filename = `removed-${hash}.png`;
      const url = this.saveImageAsset(pngBuffer, filename);

      this.logger.log(`removeBackground: saved ${filename} (${pngBuffer.length} bytes)`);

      return { url };
    } catch (error) {
      if (
        error instanceof ServiceUnavailableException ||
        error instanceof BadRequestException ||
        error instanceof InternalServerErrorException
      ) {
        throw error;
      }
      // Network error — Python service is likely down
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `removeBackground: failed to reach image-processor: ${errMsg}`,
        errStack,
      );
      throw new ServiceUnavailableException(
        'Image processing service is temporarily unavailable',
      );
    }
  }

  /**
   * Convert an uploaded PDF to images by forwarding it to the Python
   * image-processor microservice (PyMuPDF at 300 DPI).
   * Returns an array of image URLs, one per PDF page.
   */
  async pdfToImages(file: Express.Multer.File): Promise<{ urls: string[]; pageCount: number }> {
    validateCustomizerUpload(file, 'pdf');

    try {
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(file.buffer)], { type: 'application/pdf' });
      formData.append('file', blob, file.originalname || 'document.pdf');

      this.logger.log(
        `pdfToImages: forwarding ${file.originalname} (${file.size} bytes) to image-processor`,
      );

      const response = await fetch(`${IMAGE_PROCESSOR_URL}/pdf-to-images`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown error');
        if (response.status === 503) {
          throw new ServiceUnavailableException(
            'Image processing service is temporarily unavailable',
          );
        }
        throw new InternalServerErrorException(
          `Image processor error (${response.status}): ${errText}`,
        );
      }

      const data = (await response.json()) as {
        images: string[];
        pageCount: number;
        dpi: number;
      };

      if (!data.images || !Array.isArray(data.images)) {
        throw new InternalServerErrorException(
          'Invalid response from image processor',
        );
      }

      const hash = crypto
        .createHash('sha256')
        .update(file.buffer)
        .digest('hex')
        .substring(0, 12);

      const urls: string[] = [];
      for (let i = 0; i < data.images.length; i++) {
        const imgBuffer = Buffer.from(data.images[i], 'base64');
        const filename = `pdf-${hash}-page-${i}.png`;
        const url = this.saveImageAsset(imgBuffer, filename);
        urls.push(url);
      }

      this.logger.log(
        `pdfToImages: saved ${urls.length} pages for ${file.originalname}`,
      );

      return { urls, pageCount: data.pageCount ?? urls.length };
    } catch (error) {
      if (
        error instanceof ServiceUnavailableException ||
        error instanceof BadRequestException ||
        error instanceof InternalServerErrorException
      ) {
        throw error;
      }
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `pdfToImages: failed to reach image-processor: ${errMsg}`,
        errStack,
      );
      throw new ServiceUnavailableException(
        'Image processing service is temporarily unavailable',
      );
    }
  }

  /**
   * Save an image buffer to the .customizer-assets/ directory and return
   * the publicly accessible URL.
   */
  private saveImageAsset(buffer: Buffer, filename: string): string {
    if (!fs.existsSync(this.imageAssetsDir)) {
      fs.mkdirSync(this.imageAssetsDir, { recursive: true });
    }
    const filepath = path.join(this.imageAssetsDir, filename);
    fs.writeFileSync(filepath, buffer);
    return `/customizer-assets/${filename}`;
  }

  // ===========================================================================
  // Admin Dashboard & Management (Admin)
  // ===========================================================================

  async getDashboardStats(
    user: any,
  ): Promise<{
    templateCount: number;
    designCount: number;
    inquiryCount: number;
    pendingInquiryCount: number;
  }> {
    const companyIds = user?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0) {
      return {
        templateCount: 0,
        designCount: 0,
        inquiryCount: 0,
        pendingInquiryCount: 0,
      };
    }

    const [templateCount, designCount, inquiryCount, pendingInquiryCount] =
      await Promise.all([
        this.prisma.customizerTemplate.count({
          where: { companyId: { in: companyIds } },
        }),
        this.prisma.customizerDesign.count({
          where: { companyId: { in: companyIds } },
        }),
        this.prisma.customizerInquiry.count({
          where: { design: { companyId: { in: companyIds } } },
        }),
        this.prisma.customizerInquiry.count({
          where: {
            design: { companyId: { in: companyIds } },
            status: 'new',
          },
        }),
      ]);

    return {
      templateCount,
      designCount,
      inquiryCount,
      pendingInquiryCount,
    };
  }

  async getRecentInquiries(limit: number, user: any): Promise<any[]> {
    const companyIds = user?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0) {
      return [];
    }

    const inquiries = await this.prisma.customizerInquiry.findMany({
      where: { design: { companyId: { in: companyIds } } },
      include: {
        design: {
          select: {
            id: true,
            shareCode: true,
            customerName: true,
            customerEmail: true,
            customerPhone: true,
            thumbnailUrl: true,
            template: {
              select: { id: true, name: true, slug: true },
            },
          },
        },
        quote: {
          select: { id: true, referenceNo: true, status: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return inquiries.map((i) => ({
      ...i,
      unitPrice: i.unitPrice ? Number(i.unitPrice) : null,
      totalPrice: i.totalPrice ? Number(i.totalPrice) : null,
    }));
  }

  async getRecentDesigns(limit: number, user: any): Promise<any[]> {
    const companyIds = user?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0) {
      return [];
    }

    const designs = await this.prisma.customizerDesign.findMany({
      where: { companyId: { in: companyIds } },
      include: {
        template: {
          select: {
            id: true,
            name: true,
            slug: true,
            basePrice: true,
            currency: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return designs.map((d) => ({
      ...d,
      template: {
        ...d.template,
        basePrice: Number(d.template.basePrice),
      },
    }));
  }

  async listTemplatesAdmin(
    query: {
      page: number;
      pageSize: number;
      search?: string;
      status?: string;
    },
    user: any,
  ): Promise<{
    items: any[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const companyIds = user?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0) {
      return {
        items: [],
        total: 0,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: 0,
      };
    }

    const { page = 1, pageSize = 20, search, status } = query;
    const skip = (page - 1) * pageSize;

    // Do NOT filter by isPublished — admin sees all templates
    const where: any = {
      companyId: { in: companyIds },
    };
    if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }
    if (status === 'published') {
      where.isPublished = true;
    } else if (status === 'unpublished') {
      where.isPublished = false;
    }

    const [templates, total] = await Promise.all([
      this.prisma.customizerTemplate.findMany({
        where,
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          modelUrl: true,
          basePrice: true,
          currency: true,
          moq: true,
          leadTimeDays: true,
          isPublished: true,
          sortOrder: true,
          createdAt: true,
          updatedAt: true,
          product: {
            select: { id: true, name: true, sku: true },
          },
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.customizerTemplate.count({ where }),
    ]);

    return {
      items: templates.map((t) => ({
        ...t,
        basePrice: Number(t.basePrice),
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getTemplateDetailAdmin(id: string, user: any): Promise<any> {
    const template = await this.prisma.customizerTemplate.findUnique({
      where: { id },
      include: {
        regions: { orderBy: { sortOrder: 'asc' } },
        materials: { orderBy: { sortOrder: 'asc' } },
        logoEffects: { orderBy: { sortOrder: 'asc' } },
        product: {
          select: { id: true, name: true, sku: true },
        },
      },
    });

    if (!template) {
      throw new NotFoundException(`Template ${id} not found`);
    }

    // Admin access — do NOT check isPublished
    this.ensureCompanyAccess(user, template.companyId);

    return {
      ...template,
      basePrice: Number(template.basePrice),
      modelUrl: template.modelUrl
        ? `/api/customizer/templates/${id}/model`
        : '',
      regions: template.regions,
      materials: template.materials.map((m) => ({
        ...m,
        priceModifier: Number(m.priceModifier),
      })),
      logoEffects: template.logoEffects.map((e) => ({
        ...e,
        pricePerColor: Number(e.pricePerColor),
      })),
    };
  }

  async deleteTemplate(
    id: string,
    user: any,
  ): Promise<{ id: string; deleted: boolean }> {
    const template = await this.prisma.customizerTemplate.findUnique({
      where: { id },
      select: { id: true, companyId: true, modelUrl: true },
    });

    if (!template) {
      throw new NotFoundException(`Template ${id} not found`);
    }

    this.ensureCompanyAccess(user, template.companyId);

    // Prevent deletion if there are linked designs (FK constraint)
    const designCount = await this.prisma.customizerDesign.count({
      where: { templateId: id },
    });
    if (designCount > 0) {
      throw new BadRequestException(
        `Cannot delete template with ${designCount} linked design(s). Remove or reassign designs first.`,
      );
    }

    // Delete the model file if it exists
    if (template.modelUrl) {
      const oldPath = path.resolve(template.modelUrl);
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }

    await this.prisma.customizerTemplate.delete({
      where: { id },
    });

    return { id, deleted: true };
  }

  async listDesigns(
    query: {
      page: number;
      pageSize: number;
      status?: string;
      search?: string;
      templateId?: string;
    },
    user: any,
  ): Promise<{
    items: any[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const companyIds = user?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0) {
      return {
        items: [],
        total: 0,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: 0,
      };
    }

    const { page = 1, pageSize = 20, status, search, templateId } = query;
    const skip = (page - 1) * pageSize;

    const where: any = {
      companyId: { in: companyIds },
    };
    if (status) {
      where.status = status;
    }
    if (templateId) {
      where.templateId = templateId;
    }
    if (search) {
      where.OR = [
        { shareCode: { contains: search, mode: 'insensitive' } },
        { customerName: { contains: search, mode: 'insensitive' } },
        { customerEmail: { contains: search, mode: 'insensitive' } },
        { template: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [designs, total] = await Promise.all([
      this.prisma.customizerDesign.findMany({
        where,
        include: {
          template: {
            select: {
              id: true,
              name: true,
              slug: true,
              basePrice: true,
              currency: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.customizerDesign.count({ where }),
    ]);

    return {
      items: designs.map((d) => ({
        ...d,
        template: {
          ...d.template,
          basePrice: Number(d.template.basePrice),
        },
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getDesignDetailById(id: string, user: any): Promise<any> {
    const design = await this.prisma.customizerDesign.findUnique({
      where: { id },
      include: {
        template: {
          select: {
            id: true,
            name: true,
            slug: true,
            basePrice: true,
            currency: true,
            moq: true,
            isPublished: true,
            regions: { orderBy: { sortOrder: 'asc' } },
            materials: { orderBy: { sortOrder: 'asc' } },
            logoEffects: { orderBy: { sortOrder: 'asc' } },
          },
        },
        inquiries: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!design) {
      throw new NotFoundException(`Design ${id} not found`);
    }

    this.ensureCompanyAccess(user, design.companyId);

    return {
      ...design,
      template: {
        ...design.template,
        basePrice: Number(design.template.basePrice),
        materials: design.template.materials.map((m) => ({
          ...m,
          priceModifier: Number(m.priceModifier),
        })),
        logoEffects: design.template.logoEffects.map((e) => ({
          ...e,
          pricePerColor: Number(e.pricePerColor),
        })),
      },
      inquiries: design.inquiries.map((i) => ({
        ...i,
        unitPrice: i.unitPrice ? Number(i.unitPrice) : null,
        totalPrice: i.totalPrice ? Number(i.totalPrice) : null,
      })),
    };
  }

  async updateDesignStatus(
    id: string,
    status: string,
    user: any,
  ): Promise<any> {
    const design = await this.prisma.customizerDesign.findUnique({
      where: { id },
      select: { id: true, companyId: true },
    });

    if (!design) {
      throw new NotFoundException(`Design ${id} not found`);
    }

    this.ensureCompanyAccess(user, design.companyId);

    const updated = await this.prisma.customizerDesign.update({
      where: { id },
      data: { status },
      include: {
        template: {
          select: {
            id: true,
            name: true,
            slug: true,
            basePrice: true,
            currency: true,
          },
        },
      },
    });

    return {
      ...updated,
      template: {
        ...updated.template,
        basePrice: Number(updated.template.basePrice),
      },
    };
  }

  async updateInquiryStatus(
    id: string,
    status: string,
    user: any,
  ): Promise<any> {
    const inquiry = await this.prisma.customizerInquiry.findUnique({
      where: { id },
      include: {
        design: {
          select: {
            id: true,
            companyId: true,
          },
        },
      },
    });

    if (!inquiry) {
      throw new NotFoundException(`Inquiry ${id} not found`);
    }

    this.ensureCompanyAccess(user, inquiry.design.companyId);

    const updated = await this.prisma.customizerInquiry.update({
      where: { id },
      data: { status },
      include: {
        design: {
          select: {
            id: true,
            shareCode: true,
            customerName: true,
            customerEmail: true,
            customerPhone: true,
            thumbnailUrl: true,
            template: {
              select: { id: true, name: true, slug: true },
            },
          },
        },
        quote: {
          select: { id: true, referenceNo: true, status: true },
        },
      },
    });

    return {
      ...updated,
      unitPrice: updated.unitPrice ? Number(updated.unitPrice) : null,
      totalPrice: updated.totalPrice ? Number(updated.totalPrice) : null,
    };
  }

  // ===========================================================================
  // Access Control
  // ===========================================================================

  private ensureCompanyAccess(user: any, companyId: string) {
    const companyIds = user?.companies?.map((c: any) => c.id) || [];
    if (companyIds.length === 0 || !companyIds.includes(companyId)) {
      throw new ForbiddenException('Access denied to this company resource');
    }
  }
}
