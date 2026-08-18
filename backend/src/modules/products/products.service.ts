import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/create-category.dto';
import { CreateAttributeDto, UpdateAttributeDto } from './dto/create-attribute.dto';
import { CreateProductDto, UpdateProductDto } from './dto/create-product.dto';
import usdPriceCatalog from './data/usd-price-catalog.json';
import { requireActiveCompany } from '../../common/utils/data-isolation';
import {
  CreateProductSpecDto,
  UpdateProductSpecDto,
} from './dto/product-spec.dto';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  private getCompanyId(user: any) {
    return requireActiveCompany(user).id;
  }

  private requireTenantManager(user: any) {
    const active = requireActiveCompany(user);
    if (!['super_admin', 'company_admin', 'sales_manager'].includes(active.role)) {
      throw new ForbiddenException('A tenant manager role is required');
    }
    return active.id;
  }

  // ========== Category ==========

  async listCategories(user: any) {
    const companyId = this.getCompanyId(user);

    const categories = await this.prisma.productCategory.findMany({
      where: { companyId },
      include: { attributeTemplates: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { sortOrder: 'asc' },
    });
    return categories;
  }

  async createCategory(user: any, dto: CreateCategoryDto) {
    const companyId = this.requireTenantManager(user);

    const existing = await this.prisma.productCategory.findUnique({
      where: { companyId_name: { companyId, name: dto.name } },
    });
    if (existing) throw new ConflictException('品类名称已存在');

    return this.prisma.productCategory.create({
      data: {
        companyId,
        name: dto.name,
        description: dto.description,
        sortOrder: dto.sortOrder ?? 0,
      },
      include: { attributeTemplates: true },
    });
  }

  async updateCategory(user: any, id: string, dto: UpdateCategoryDto) {
    this.requireTenantManager(user);
    const category = await this.getCategoryOrThrow(user, id);
    return this.prisma.productCategory.update({
      where: { id: category.id },
      data: { ...dto },
      include: { attributeTemplates: true },
    });
  }

  async deleteCategory(user: any, id: string) {
    this.requireTenantManager(user);
    const category = await this.getCategoryOrThrow(user, id);
    const productCount = await this.prisma.product.count({ where: { categoryId: id } });
    if (productCount > 0) {
      throw new ConflictException(`该品类下有 ${productCount} 个产品，请先删除或转移产品`);
    }
    return this.prisma.productCategory.delete({ where: { id: category.id } });
  }

  // ========== Attribute Template ==========

  async createAttribute(user: any, categoryId: string, dto: CreateAttributeDto) {
    this.requireTenantManager(user);
    await this.getCategoryOrThrow(user, categoryId);

    const existing = await this.prisma.attributeTemplate.findUnique({
      where: { categoryId_name: { categoryId, name: dto.name } },
    });
    if (existing) throw new ConflictException('属性名称已存在');

    return this.prisma.attributeTemplate.create({
      data: {
        categoryId,
        name: dto.name,
        type: dto.type,
        options: dto.options ?? undefined,
        unit: dto.unit,
        required: dto.required ?? false,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async updateAttribute(user: any, categoryId: string, attrId: string, dto: UpdateAttributeDto) {
    this.requireTenantManager(user);
    await this.getCategoryOrThrow(user, categoryId);
    const attr = await this.prisma.attributeTemplate.findFirst({
      where: { id: attrId, categoryId },
    });
    if (!attr) throw new NotFoundException('属性模板不存在');

    return this.prisma.attributeTemplate.update({
      where: { id: attrId },
      data: { ...dto },
    });
  }

  async deleteAttribute(user: any, categoryId: string, attrId: string) {
    this.requireTenantManager(user);
    await this.getCategoryOrThrow(user, categoryId);
    const attr = await this.prisma.attributeTemplate.findFirst({
      where: { id: attrId, categoryId },
    });
    if (!attr) throw new NotFoundException('属性模板不存在');

    return this.prisma.attributeTemplate.delete({ where: { id: attrId } });
  }

  // ========== Product ==========

  async listProducts(user: any, query: { page?: number; limit?: number; categoryId?: string; search?: string; productType?: string }) {
    const companyId = this.getCompanyId(user);

    const page = query.page || 1;
    const limit = query.limit || 20;
    const where: any = {
      companyId,
      isActive: true,
      category: { companyId },
    };

    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.productType) where.productType = query.productType;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { sku: { contains: query.search, mode: 'insensitive' } },
        { productCode: { contains: query.search, mode: 'insensitive' } },
        { material: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: {
          category: { select: { id: true, name: true } },
          specs: { where: { isActive: true }, orderBy: { unitPrice: 'asc' } },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getProduct(user: any, id: string) {
    const companyId = this.getCompanyId(user);
    const product = await this.prisma.product.findFirst({
      where: { id, companyId, category: { companyId } },
      include: {
        category: {
          include: { attributeTemplates: { orderBy: { sortOrder: 'asc' } } },
        },
        specs: { where: { isActive: true }, orderBy: { unitPrice: 'asc' } },
      },
    });
    if (!product) throw new NotFoundException('产品不存在');
    return product;
  }

  /**
   * 搜索产品和规格 — 供 AI 报价使用
   */
  async searchProductSpecs(user: any, query: { q?: string; categoryId?: string }) {
    const companyId = this.getCompanyId(user);
    const where: any = {
      companyId,
      isActive: true,
      category: { companyId },
    };

    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: 'insensitive' } },
        { sku: { contains: query.q, mode: 'insensitive' } },
        { productCode: { contains: query.q, mode: 'insensitive' } },
        { material: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    const products = await this.prisma.product.findMany({
      where,
      include: {
        specs: { where: { isActive: true }, orderBy: { unitPrice: 'asc' } },
        category: { select: { id: true, name: true } },
      },
      take: 20,
      orderBy: { updatedAt: 'desc' },
    });

    // 展平为 spec 级别的结果
    const results = products.flatMap((p) =>
      p.specs.map((s) => ({
        productId: p.id,
        productCode: p.productCode,
        productName: p.name,
        material: p.material,
        thickness: p.thickness,
        productType: p.productType,
        categoryName: p.category?.name,
        specId: s.id,
        specCode: s.specCode,
        size: s.size,
        specThickness: s.thicknessCm,
        unitPrice: s.unitPrice,
        moq: s.moq,
        packPerBundle: s.packPerBundle,
        bundleWeightKg: s.bundleWeightKg,
        cartonSize: s.cartonSize,
      })),
    );

    return { data: results, total: results.length };
  }

  searchUsdPricingCatalog(user: any, q?: string, requestedLimit = 50) {
    this.getCompanyId(user);
    const needle = (q || '').trim().toLocaleLowerCase('zh-CN');
    const limit = Math.min(Math.max(requestedLimit, 1), 168);
    const items = usdPriceCatalog.items.filter((item) => {
      if (!needle) return true;
      return [item.catalogItemId, item.categoryCn, item.categoryEn, item.size, item.thickness]
        .some((value) => value.toLocaleLowerCase('zh-CN').includes(needle));
    }).slice(0, limit);

    return {
      data: items,
      total: items.length,
      catalogTotal: usdPriceCatalog.items.length,
      priceVersion: usdPriceCatalog.priceVersion,
      effectiveAt: usdPriceCatalog.effectiveAt,
      source: usdPriceCatalog.source,
      sourceSha256: usdPriceCatalog.sourceSha256,
      pricingPolicy: usdPriceCatalog.pricingPolicy,
    };
  }

  // ========== Product Spec ==========

  async addProductSpec(user: any, productId: string, dto: CreateProductSpecDto) {
    this.requireTenantManager(user);
    await this.getProduct(user, productId);
    return this.prisma.productSpec.create({
      data: {
        productId,
        specCode: dto.specCode || dto.size,
        size: dto.size,
        widthCm: dto.widthCm || null,
        lengthCm: dto.lengthCm || null,
        gussetCm: dto.gussetCm || null,
        thicknessCm: dto.thicknessCm || null,
        unitPrice: dto.unitPrice,
        moq: dto.moq || 1,
        packPerBundle: dto.packPerBundle || null,
        bundleWeightKg: dto.bundleWeightKg || null,
        cartonSize: dto.cartonSize || null,
        cartonLengthCm: dto.cartonLengthCm || null,
        cartonWidthCm: dto.cartonWidthCm || null,
        cartonHeightCm: dto.cartonHeightCm || null,
        isActive: true,
      },
    });
  }

  async updateProductSpec(
    user: any,
    productId: string,
    specId: string,
    dto: UpdateProductSpecDto,
  ) {
    this.requireTenantManager(user);
    await this.getProduct(user, productId);
    const forbiddenField = ['id', 'productId', 'isActive'].find((field) =>
      Object.prototype.hasOwnProperty.call(dto, field),
    );
    if (forbiddenField) {
      throw new BadRequestException(
        `Product spec field cannot be updated: ${forbiddenField}`,
      );
    }
    const spec = await this.prisma.productSpec.findFirst({ where: { id: specId, productId } });
    if (!spec) throw new NotFoundException('规格不存在');
    const data: any = {};
    const allowedFields: Array<keyof UpdateProductSpecDto> = [
      'specCode', 'size', 'widthCm', 'lengthCm', 'gussetCm',
      'thicknessCm', 'unitPrice', 'moq', 'packPerBundle',
      'bundleWeightKg', 'cartonSize', 'cartonLengthCm',
      'cartonWidthCm', 'cartonHeightCm',
    ];
    for (const field of allowedFields) {
      if (dto[field] !== undefined) data[field] = dto[field];
    }
    const result = await this.prisma.productSpec.updateMany({
      where: { id: specId, productId },
      data,
    });
    if (result.count !== 1) throw new NotFoundException('Product spec not found');
    return this.prisma.productSpec.findFirst({
      where: { id: specId, productId },
    });
  }

  async deleteProductSpec(user: any, productId: string, specId: string) {
    this.requireTenantManager(user);
    await this.getProduct(user, productId);
    const spec = await this.prisma.productSpec.findFirst({ where: { id: specId, productId } });
    if (!spec) throw new NotFoundException('规格不存在');
    const result = await this.prisma.productSpec.updateMany({
      where: { id: specId, productId },
      data: { isActive: false },
    });
    if (result.count !== 1) throw new NotFoundException('Product spec not found');
    return this.prisma.productSpec.findFirst({
      where: { id: specId, productId },
    });
  }

  async createProduct(user: any, dto: CreateProductDto) {
    const companyId = this.requireTenantManager(user);

    let categoryId = dto.categoryId;

    // If categoryName is provided, auto-create or find the category
    if (!categoryId && dto.categoryName) {
      let cat = await this.prisma.productCategory.findUnique({
        where: { companyId_name: { companyId, name: dto.categoryName } },
      });
      if (!cat) {
        cat = await this.prisma.productCategory.create({
          data: { companyId, name: dto.categoryName },
        });
      }
      categoryId = cat.id;
    }

    if (!categoryId) throw new NotFoundException('请选择产品品类');

    await this.getCategoryOrThrow(user, categoryId);

    const existingSku = await this.prisma.product.findUnique({
      where: { companyId_sku: { companyId, sku: dto.sku } },
    });
    if (existingSku) throw new ConflictException('SKU 已存在');

    return this.prisma.product.create({
      data: {
        companyId,
        categoryId,
        sku: dto.sku,
        name: dto.name,
        productCode: dto.productCode || dto.sku,
        material: dto.material || null,
        thickness: dto.thickness || null,
        productType: dto.productType || null,
        description: dto.description,
        basePrice: dto.basePrice ?? 0,
        currency: dto.currency ?? 'CNY',
        attributes: dto.attributes ?? {},
        images: dto.images ?? [],
      },
      include: {
        category: {
          include: { attributeTemplates: { orderBy: { sortOrder: 'asc' } } },
        },
      },
    });
  }

  async updateProduct(user: any, id: string, dto: UpdateProductDto) {
    this.requireTenantManager(user);
    const product = await this.getProduct(user, id);

    let categoryId = dto.categoryId ?? product.categoryId;
    if (dto.categoryId) {
      await this.getCategoryOrThrow(user, dto.categoryId);
    }

    if (!dto.categoryId && dto.categoryName) {
      let cat = await this.prisma.productCategory.findUnique({
        where: { companyId_name: { companyId: product.companyId, name: dto.categoryName } },
      });
      if (!cat) {
        cat = await this.prisma.productCategory.create({
          data: { companyId: product.companyId, name: dto.categoryName },
        });
      }
      categoryId = cat.id;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { categoryName, ...data } = dto;
    delete (data as any).categoryName;

    return this.prisma.product.update({
      where: { id },
      data: { ...data, categoryId },
      include: {
        category: {
          include: { attributeTemplates: { orderBy: { sortOrder: 'asc' } } },
        },
      },
    });
  }

  async deleteProduct(user: any, id: string) {
    this.requireTenantManager(user);
    await this.getProduct(user, id);
    return this.prisma.product.update({
      where: { id },
      data: { isActive: false },
    });
  }

  // ========== Private helpers ==========

  private async getCategoryOrThrow(user: any, id: string) {
    const companyId = this.getCompanyId(user);
    const category = await this.prisma.productCategory.findFirst({
      where: { id, companyId },
    });
    if (!category) throw new NotFoundException('品类不存在');
    return category;
  }
}
