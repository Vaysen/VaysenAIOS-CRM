import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ProductsService } from './products.service';

const tenantManager = {
  id: 'manager-a',
  activeCompanyId: 'tenant-a',
  activeCompany: { id: 'tenant-a', role: 'company_admin' },
  companies: [{ id: 'tenant-a', role: 'company_admin' }],
};

describe('ProductsService tenant mutation isolation', () => {
  it('does not create a product with a foreign category id', async () => {
    const prisma: any = {
      productCategory: { findFirst: jest.fn().mockResolvedValue(null) },
      product: { create: jest.fn(), findUnique: jest.fn() },
    };
    const service = new ProductsService(prisma);

    await expect(service.createProduct(tenantManager, {
      sku: 'A-1',
      name: 'Product A',
      categoryId: 'tenant-b-category',
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.productCategory.findFirst).toHaveBeenCalledWith({
      where: { id: 'tenant-b-category', companyId: 'tenant-a' },
    });
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it('does not update a product to a foreign category id', async () => {
    const prisma: any = {
      product: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'product-a',
          companyId: 'tenant-a',
          categoryId: 'category-a',
        }),
        update: jest.fn(),
      },
      productCategory: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new ProductsService(prisma);

    await expect(service.updateProduct(
      tenantManager,
      'product-a',
      { categoryId: 'tenant-b-category' },
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it('does not update a foreign spec through an accessible product id', async () => {
    const prisma: any = {
      product: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'product-a',
          companyId: 'tenant-a',
          categoryId: 'category-a',
        }),
      },
      productSpec: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn(),
      },
    };
    const service = new ProductsService(prisma);

    await expect(service.updateProductSpec(
      tenantManager,
      'product-a',
      'tenant-b-spec',
      { size: '10x10' },
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.productSpec.findFirst).toHaveBeenCalledWith({
      where: { id: 'tenant-b-spec', productId: 'product-a' },
    });
    expect(prisma.productSpec.updateMany).not.toHaveBeenCalled();
  });

  it.each(['productId', 'id', 'isActive'])(
    'rejects product spec field injection through %s',
    async (field) => {
      const prisma: any = {
        product: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'product-a',
            companyId: 'tenant-a',
            categoryId: 'category-a',
          }),
        },
        productSpec: {
          findFirst: jest.fn(),
          updateMany: jest.fn(),
        },
      };
      const service = new ProductsService(prisma);

      await expect(service.updateProductSpec(
        tenantManager,
        'product-a',
        'spec-a',
        { [field]: field === 'isActive' ? false : 'tenant-b-value' } as any,
      )).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.productSpec.findFirst).not.toHaveBeenCalled();
      expect(prisma.productSpec.updateMany).not.toHaveBeenCalled();
    },
  );
});
