import { ForbiddenException } from '@nestjs/common';
import { MaterialsService } from '../modules/materials/materials.service';
import { ProductsService } from '../modules/products/products.service';
import { TagsService } from '../modules/tags/tags.service';

const viewer = {
  id: 'viewer',
  activeCompanyId: 'A',
  activeCompany: { id: 'A', role: 'viewer' },
  companies: [{ id: 'A', role: 'viewer' }],
};

describe('catalog write role boundaries', () => {
  it.each([
    ['product', () => new ProductsService({} as any).createCategory(viewer, { name: 'Denied' } as any)],
    ['tag', () => new TagsService({} as any).create({ name: 'Denied' }, viewer)],
    ['material', () => {
      const service = Object.create(MaterialsService.prototype) as MaterialsService;
      return service.remove('material-id', viewer);
    }],
  ])('rejects viewer %s writes before database access', async (_name, operation) => {
    await expect(operation()).rejects.toBeInstanceOf(ForbiddenException);
  });
});
