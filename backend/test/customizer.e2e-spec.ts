/* =============================================================================
   Customizer E2E Tests (TASK-049)
   Covers: Template CRUD, Design save/load, Inquiry submission, Pricing calculation.
   Uses supertest + @nestjs/testing with a mocked PrismaService.
   ============================================================================= */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { CustomizerModule } from '../src/modules/customizer/customizer.module';
import { PrismaModule } from '../src/common/prisma/prisma.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { CustomizerPricingService } from '../src/modules/customizer/customizer-pricing.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';

/* ========================================
   Test fixtures
   ======================================== */

const mockUser = {
  id: 'user-1',
  email: 'admin@test.com',
  companies: [{ id: 'company-1', name: 'Test Company' }],
};

const templateFixture = {
  id: 'tpl-1',
  companyId: 'company-1',
  productId: null,
  name: 'Stand-Up Pouch',
  slug: 'stand-up-pouch',
  description: 'A stand-up pouch template',
  modelUrl: '.customizer-assets/models/tpl-1.glb',
  modelFormat: 'glb',
  textureSize: 2048,
  unfoldLayout: {},
  basePrice: 0.50,
  currency: 'USD',
  moq: 10000,
  leadTimeDays: 20,
  isPublished: true,
  sortOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  regions: [],
  materials: [
    { id: 'mat-1', templateId: 'tpl-1', name: 'Matte', type: 'matte', colorHex: '#ffffff', textureUrl: null, priceModifier: 0.05, sortOrder: 0 },
  ],
  logoEffects: [
    { id: 'eff-1', templateId: 'tpl-1', name: 'hot-stamp-gold', label: 'Hot Stamp Gold', previewUrl: null, pricePerColor: 0.08, minColors: 1, sortOrder: 0 },
  ],
  product: { id: 'prod-1', name: 'Pouch Product', sku: 'POUCH-001' },
};

const designFixture = {
  id: 'design-1',
  companyId: 'company-1',
  templateId: 'tpl-1',
  leadId: null,
  shareCode: 'ABC123',
  customerName: 'John Doe',
  customerEmail: 'john@test.com',
  customerPhone: '+1234567890',
  config: {
    regionContent: {},
    materialId: 'mat-1',
    colorHex: '#ff0000',
    logoEffectId: 'eff-1',
    quantity: 10000,
    notes: 'Test design',
  },
  thumbnailUrl: null,
  status: 'draft',
  createdAt: new Date(),
  updatedAt: new Date(),
  submittedAt: null,
  template: {
    id: 'tpl-1',
    name: 'Stand-Up Pouch',
    slug: 'stand-up-pouch',
    basePrice: 0.50,
    currency: 'USD',
    moq: 10000,
    isPublished: true,
    regions: [],
    materials: templateFixture.materials,
    logoEffects: templateFixture.logoEffects,
  },
};

const inquiryFixture = {
  id: 'inq-1',
  designId: 'design-1',
  quoteId: null,
  quantity: 10000,
  unitPrice: 0.63,
  totalPrice: 6300,
  currency: 'USD',
  status: 'new',
  notes: 'Need urgent delivery',
  createdAt: new Date(),
  updatedAt: new Date(),
  design: {
    id: 'design-1',
    shareCode: 'ABC123',
    customerName: 'John Doe',
    customerEmail: 'john@test.com',
    customerPhone: '+1234567890',
    template: { id: 'tpl-1', name: 'Stand-Up Pouch', slug: 'stand-up-pouch' },
  },
};

/* ========================================
   Mock PrismaService factory
   ======================================== */

function createMockPrisma(): any {
  return {
    customizerTemplate: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    customizerRegion: {
      deleteMany: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    customizerMaterial: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    customizerLogoEffect: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    customizerDesign: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    customizerInquiry: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    lead: {
      findFirst: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    product: {
      findUnique: jest.fn(),
    },
    quote: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

/* ========================================
   Test Suite
   ======================================== */

describe('Customizer E2E (TASK-049)', () => {
  let app: INestApplication;
  let mockPrisma: any;

  beforeAll(async () => {
    mockPrisma = createMockPrisma();

    // Mock guard that bypasses JWT auth and injects a test user into request
    const mockAuthGuard = {
      canActivate: (context: any) => {
        const request = context.switchToHttp().getRequest();
        request.user = mockUser;
        return true;
      },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, CustomizerModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .overrideGuard(JwtAuthGuard)
      .useValue(mockAuthGuard)
      .compile();

    app = moduleFixture.createNestApplication();
    // Override APP_GUARD global guard with mock
    app.useGlobalGuards(mockAuthGuard as any);
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /* ========================================
     1. Template CRUD
     ======================================== */

  describe('Template CRUD', () => {
    it('GET /api/customizer/templates — should list published templates', async () => {
      mockPrisma.customizerTemplate.findMany.mockResolvedValue([templateFixture]);
      mockPrisma.customizerTemplate.count.mockResolvedValue(1);

      const res = await request(app.getHttpServer())
        .get('/api/customizer/templates')
        .query({ page: 1, pageSize: 20 })
        .expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].name).toBe('Stand-Up Pouch');
      expect(res.body.items[0].basePrice).toBe(0.5);
      expect(res.body.total).toBe(1);
    });

    it('GET /api/customizer/templates/:id — should return template detail', async () => {
      mockPrisma.customizerTemplate.findUnique.mockResolvedValue(templateFixture);

      const res = await request(app.getHttpServer())
        .get('/api/customizer/templates/tpl-1')
        .expect(200);

      expect(res.body.id).toBe('tpl-1');
      expect(res.body.name).toBe('Stand-Up Pouch');
      expect(res.body.materials).toHaveLength(1);
      expect(res.body.materials[0].priceModifier).toBe(0.05);
      expect(res.body.logoEffects[0].pricePerColor).toBe(0.08);
      expect(res.body.modelUrl).toContain('/api/customizer/templates/tpl-1/model');
    });

    it('GET /api/customizer/templates/:id — should return 404 for unpublished template', async () => {
      mockPrisma.customizerTemplate.findUnique.mockResolvedValue({
        ...templateFixture,
        isPublished: false,
      });

      await request(app.getHttpServer())
        .get('/api/customizer/templates/tpl-1')
        .expect(404);
    });

    it('POST /api/customizer/admin/templates — should create a template (admin)', async () => {
      mockPrisma.customizerTemplate.findUnique.mockResolvedValue(null); // slug not taken
      mockPrisma.customizerTemplate.create.mockResolvedValue(templateFixture);

      const res = await request(app.getHttpServer())
        .post('/api/customizer/admin/templates')
        .send({
          name: 'Stand-Up Pouch',
          slug: 'stand-up-pouch',
          basePrice: 0.50,
          currency: 'USD',
          moq: 10000,
          leadTimeDays: 20,
        })
        .expect(201);

      expect(res.body.name).toBe('Stand-Up Pouch');
      expect(mockPrisma.customizerTemplate.create).toHaveBeenCalled();
    });

    it('POST /api/customizer/admin/templates — should reject duplicate slug', async () => {
      mockPrisma.customizerTemplate.findUnique.mockResolvedValue(templateFixture);

      await request(app.getHttpServer())
        .post('/api/customizer/admin/templates')
        .send({
          name: 'Duplicate',
          slug: 'stand-up-pouch',
          basePrice: 0.50,
        })
        .expect(409);
    });

    it('PUT /api/customizer/admin/templates/:id — should update a template', async () => {
      mockPrisma.customizerTemplate.findUnique.mockResolvedValue(templateFixture);
      const updated = { ...templateFixture, name: 'Updated Pouch', basePrice: 0.60 };
      mockPrisma.customizerTemplate.update.mockResolvedValue(updated);

      const res = await request(app.getHttpServer())
        .put('/api/customizer/admin/templates/tpl-1')
        .send({ name: 'Updated Pouch', basePrice: 0.60 })
        .expect(200);

      expect(res.body.name).toBe('Updated Pouch');
      expect(res.body.basePrice).toBe(0.6);
    });

    it('PATCH /api/customizer/admin/templates/:id/publish — should publish a template', async () => {
      mockPrisma.customizerTemplate.findUnique.mockResolvedValue(templateFixture);
      mockPrisma.customizerTemplate.update.mockResolvedValue({
        id: 'tpl-1',
        isPublished: true,
      });

      const res = await request(app.getHttpServer())
        .patch('/api/customizer/admin/templates/tpl-1/publish')
        .send({ published: true })
        .expect(200);

      expect(res.body.isPublished).toBe(true);
    });
  });

  /* ========================================
     2. Design Save / Load
     ======================================== */

  describe('Design Save / Load', () => {
    it('POST /api/customizer/designs — should save a design and return shareCode', async () => {
      mockPrisma.customizerTemplate.findUnique.mockResolvedValue({
        id: 'tpl-1',
        isPublished: true,
        companyId: 'company-1',
      });
      mockPrisma.customizerDesign.findUnique.mockResolvedValue(null); // shareCode unique
      mockPrisma.customizerDesign.create.mockResolvedValue(designFixture);

      const res = await request(app.getHttpServer())
        .post('/api/customizer/designs')
        .send({
          templateId: 'tpl-1',
          config: designFixture.config,
          customerName: 'John Doe',
          customerEmail: 'john@test.com',
        })
        .expect(201);

      expect(res.body.id).toBe('design-1');
      expect(res.body.shareCode).toBe('ABC123');
      expect(res.body.template.name).toBe('Stand-Up Pouch');
    });

    it('POST /api/customizer/designs — should reject unpublished template', async () => {
      mockPrisma.customizerTemplate.findUnique.mockResolvedValue({
        id: 'tpl-1',
        isPublished: false,
        companyId: 'company-1',
      });

      await request(app.getHttpServer())
        .post('/api/customizer/designs')
        .send({
          templateId: 'tpl-1',
          config: {},
        })
        .expect(400);
    });

    it('GET /api/customizer/designs/:code — should load a design by shareCode', async () => {
      mockPrisma.customizerDesign.findUnique.mockResolvedValue(designFixture);

      const res = await request(app.getHttpServer())
        .get('/api/customizer/designs/ABC123')
        .expect(200);

      expect(res.body.shareCode).toBe('ABC123');
      expect(res.body.config.materialId).toBe('mat-1');
      expect(res.body.template.materials[0].priceModifier).toBe(0.05);
    });

    it('GET /api/customizer/designs/:code — should return 404 for invalid code', async () => {
      mockPrisma.customizerDesign.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get('/api/customizer/designs/INVALID')
        .expect(404);
    });

    it('PUT /api/customizer/designs/:code — should update a design', async () => {
      mockPrisma.customizerDesign.findUnique.mockResolvedValue({ id: 'design-1' });
      const updated = { ...designFixture, config: { ...designFixture.config, notes: 'Updated' } };
      mockPrisma.customizerDesign.update.mockResolvedValue(updated);

      const res = await request(app.getHttpServer())
        .put('/api/customizer/designs/ABC123')
        .send({ config: updated.config })
        .expect(200);

      expect(res.body.shareCode).toBe('ABC123');
    });
  });

  /* ========================================
     3. Inquiry Submission (with Lead auto-creation)
     ======================================== */

  describe('Inquiry Submission', () => {
    beforeEach(() => {
      // Set up the design lookup for inquiry submission
      mockPrisma.customizerDesign.findUnique.mockResolvedValue({
        ...designFixture,
        leadId: null,
        template: {
          ...templateFixture,
          materials: templateFixture.materials,
          logoEffects: templateFixture.logoEffects,
        },
      });
      mockPrisma.customizerInquiry.create.mockResolvedValue(inquiryFixture);
      mockPrisma.customizerDesign.update.mockResolvedValue(designFixture);
      // No existing lead → will create one
      mockPrisma.lead.findFirst.mockResolvedValue(null);
      mockPrisma.lead.create.mockResolvedValue({
        id: 'lead-1',
        companyId: 'company-1',
        contactEmail: 'john@test.com',
      });
    });

    it('POST /api/customizer/inquiries — should submit inquiry and auto-create a Lead', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/customizer/inquiries')
        .send({
          designId: 'design-1',
          quantity: 10000,
          customerName: 'John Doe',
          customerEmail: 'john@test.com',
          customerPhone: '+1234567890',
          notes: 'Need urgent delivery',
        })
        .expect(201);

      expect(res.body.id).toBe('inq-1');
      expect(res.body.quantity).toBe(10000);
      // Lead should be auto-created
      expect(mockPrisma.lead.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ contactEmail: 'john@test.com' }),
        }),
      );
      expect(mockPrisma.lead.create).toHaveBeenCalled();
      // Design should be updated with leadId
      expect(res.body.leadId).toBe('lead-1');
      expect(res.body.leadCreated).toBe(true);
    });

    it('POST /api/customizer/inquiries — should link existing Lead if email matches', async () => {
      // Existing lead found
      mockPrisma.lead.findFirst.mockResolvedValue({ id: 'lead-existing' });
      mockPrisma.lead.create.mockClear();

      const res = await request(app.getHttpServer())
        .post('/api/customizer/inquiries')
        .send({
          designId: 'design-1',
          quantity: 50000,
          customerName: 'John Doe',
          customerEmail: 'john@test.com',
        })
        .expect(201);

      expect(mockPrisma.lead.create).not.toHaveBeenCalled();
      expect(res.body.leadId).toBe('lead-existing');
      expect(res.body.leadCreated).toBe(false);
    });

    it('POST /api/customizer/inquiries — should return 404 for non-existent design', async () => {
      mockPrisma.customizerDesign.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post('/api/customizer/inquiries')
        .send({
          designId: 'nonexistent',
          quantity: 10000,
          customerName: 'John',
          customerEmail: 'john@test.com',
        })
        .expect(404);
    });

    it('POST /api/customizer/inquiries — should validate required fields', async () => {
      await request(app.getHttpServer())
        .post('/api/customizer/inquiries')
        .send({
          designId: 'design-1',
          // missing quantity, customerName, customerEmail
        })
        .expect(400);
    });
  });

  /* ========================================
     4. Pricing Calculation
     ======================================== */

  describe('Pricing Calculation', () => {
    let pricingService: CustomizerPricingService;

    beforeAll(() => {
      pricingService = app.get(CustomizerPricingService);
    });

    it('should calculate base price at MOQ with no discount', () => {
      const result = pricingService.calculate(
        {
          basePrice: 0.50,
          moq: 10000,
          quantity: 10000,
          materialSurcharge: 0,
          logoEffectSurcharge: 0,
        },
        'USD',
      );

      expect(result.unitPrice).toBe(0.5);
      expect(result.totalPrice).toBe(5000);
      expect(result.quantityDiscountRate).toBe(0);
      expect(result.quantityDiscount).toBe(0);
    });

    it('should apply material surcharge', () => {
      const result = pricingService.calculate(
        {
          basePrice: 0.50,
          moq: 10000,
          quantity: 10000,
          materialSurcharge: 0.05,
          logoEffectSurcharge: 0,
        },
        'USD',
      );

      // 0.50 + 0.05 = 0.55, no discount at MOQ
      expect(result.unitPrice).toBe(0.55);
      expect(result.totalPrice).toBe(5500);
      expect(result.materialSurcharge).toBe(0.05);
    });

    it('should apply logo effect surcharge', () => {
      const result = pricingService.calculate(
        {
          basePrice: 0.50,
          moq: 10000,
          quantity: 10000,
          materialSurcharge: 0,
          logoEffectSurcharge: 0.08,
        },
        'USD',
      );

      // 0.50 + 0.08 = 0.58
      expect(result.unitPrice).toBe(0.58);
      expect(result.totalPrice).toBe(5800);
    });

    it('should apply quantity discount at 2x MOQ', () => {
      const result = pricingService.calculate(
        {
          basePrice: 0.50,
          moq: 10000,
          quantity: 20000,
          materialSurcharge: 0,
          logoEffectSurcharge: 0,
        },
        'USD',
      );

      // ratio = 2, discount = (2-1) * 0.015 = 0.015
      // discount = 0.50 * 0.015 = 0.0075
      // unitPrice = 0.50 - 0.0075 = 0.4925
      expect(result.quantityDiscountRate).toBe(0.015);
      expect(result.unitPrice).toBe(0.4925);
      expect(result.totalPrice).toBe(9850);
    });

    it('should cap discount at 15% for large quantities', () => {
      const result = pricingService.calculate(
        {
          basePrice: 0.50,
          moq: 10000,
          quantity: 200000, // 20x MOQ
          materialSurcharge: 0,
          logoEffectSurcharge: 0,
        },
        'USD',
      );

      // discount capped at 0.15
      expect(result.quantityDiscountRate).toBe(0.15);
      // unitPrice = 0.50 * (1 - 0.15) = 0.425
      expect(result.unitPrice).toBe(0.425);
      expect(result.totalPrice).toBe(85000);
    });

    it('should calculate combined surcharges and discount', () => {
      const result = pricingService.calculate(
        {
          basePrice: 0.50,
          moq: 10000,
          quantity: 50000, // 5x MOQ
          materialSurcharge: 0.05,
          logoEffectSurcharge: 0.08,
        },
        'USD',
      );

      // subtotal = 0.50 + 0.05 + 0.08 = 0.63
      // ratio = 5, discount = (5-1) * 0.015 = 0.06
      // discount = 0.63 * 0.06 = 0.0378
      // unitPrice = 0.63 - 0.0378 = 0.5922
      expect(result.quantityDiscountRate).toBe(0.06);
      expect(result.unitPrice).toBe(0.5922);
      // totalPrice = 0.5922 * 50000 = 29610
      expect(result.totalPrice).toBe(29610);
    });

    it('calculateQuantityDiscountRate — should return 0 at or below MOQ', () => {
      expect(pricingService.calculateQuantityDiscountRate(5000, 10000)).toBe(0);
      expect(pricingService.calculateQuantityDiscountRate(10000, 10000)).toBe(0);
    });

    it('calculateQuantityDiscountRate — should return 0 for invalid inputs', () => {
      expect(pricingService.calculateQuantityDiscountRate(0, 10000)).toBe(0);
      expect(pricingService.calculateQuantityDiscountRate(10000, 0)).toBe(0);
      expect(pricingService.calculateQuantityDiscountRate(-1, 10000)).toBe(0);
    });
  });

  /* ========================================
     5. CRM Integration (TASK-047)
     ======================================== */

  describe('CRM Integration — Designs by Lead', () => {
    it('GET /api/customizer/admin/leads/:leadId/designs — should return designs for a lead', async () => {
      mockPrisma.lead.findUnique.mockResolvedValue({
        id: 'lead-1',
        companyId: 'company-1',
        contactName: 'John Doe',
        contactEmail: 'john@test.com',
      });
      mockPrisma.customizerDesign.findMany.mockResolvedValue([
        {
          ...designFixture,
          inquiries: [inquiryFixture],
        },
      ]);

      const res = await request(app.getHttpServer())
        .get('/api/customizer/admin/leads/lead-1/designs')
        .expect(200);

      expect(res.body.leadId).toBe('lead-1');
      expect(res.body.contactEmail).toBe('john@test.com');
      expect(res.body.designs).toHaveLength(1);
      expect(res.body.designs[0].shareCode).toBe('ABC123');
      expect(res.body.designs[0].inquiries).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });

    it('GET /api/customizer/admin/leads/:leadId/designs — should return 404 for non-existent lead', async () => {
      mockPrisma.lead.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get('/api/customizer/admin/leads/nonexistent/designs')
        .expect(404);
    });
  });
});
