import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { getMaterialsUploadDir, MaterialsService } from './materials.service';

describe('materials upload persistence path', () => {
  const original = process.env.UPLOADS_DIR;

  afterEach(() => {
    if (original === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = original;
  });

  it('uses the runtime working directory so dist and src persist to /app/uploads', () => {
    delete process.env.UPLOADS_DIR;
    expect(getMaterialsUploadDir()).toBe(path.resolve(process.cwd(), 'uploads'));
  });

  it('supports an explicit absolute persistent-volume mount', () => {
    process.env.UPLOADS_DIR = path.join(process.cwd(), 'persistent-uploads');
    expect(getMaterialsUploadDir()).toBe(path.resolve(process.env.UPLOADS_DIR));
  });

  it('does not unlink a file while another tenant has an active reference', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'materials-tenant-'));
    process.env.UPLOADS_DIR = root;
    const filename = 'legacy-shared.jpg';
    const filePath = path.join(root, filename);
    fs.writeFileSync(filePath, 'shared');
    const prisma: any = {
      material: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'material-a',
          companyId: 'tenant-a',
          filename,
          deletedAt: null,
        }),
        count: jest.fn().mockResolvedValue(1),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction = jest.fn((callback: any) => callback(prisma));
    const service = new MaterialsService(prisma);
    try {
      await service.remove('material-a', {
        id: 'admin-a',
        activeCompanyId: 'tenant-a',
        activeCompany: { id: 'tenant-a', role: 'company_admin' },
      });
      expect(prisma.material.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'material-a',
          companyId: 'tenant-a',
          deletedAt: null,
        },
      });
      expect(fs.existsSync(filePath)).toBe(true);
      expect(prisma.material.count).toHaveBeenCalledWith({
        where: { filename, deletedAt: null },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an interleaved same-content upload when removing a legacy hash path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'materials-interleave-'));
    process.env.UPLOADS_DIR = root;
    const buffer = Buffer.from('%PDF-1.4 same content');
    const legacyHash = crypto.createHash('md5').update(buffer).digest('hex').slice(0, 12);
    const legacyFilename = path.posix.join('tenant-a', `${legacyHash}.pdf`);
    const legacyFilePath = path.join(root, 'tenant-a', `${legacyHash}.pdf`);
    fs.mkdirSync(path.dirname(legacyFilePath), { recursive: true });
    fs.writeFileSync(legacyFilePath, buffer);

    let releaseCreate!: () => void;
    let markCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const createReleased = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const prisma: any = {
      material: {
        create: jest.fn(async ({ data }: any) => {
          markCreateStarted();
          await createReleased;
          return { id: 'new-material', ...data };
        }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'legacy-material',
          companyId: 'tenant-a',
          filename: legacyFilename,
          deletedAt: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    prisma.$transaction = jest.fn((callback: any) => callback(prisma));
    const service = new MaterialsService(prisma);
    const user = {
      id: 'admin-a',
      activeCompanyId: 'tenant-a',
      activeCompany: { id: 'tenant-a', role: 'company_admin' },
    };

    try {
      const uploadPromise = service.upload({
        originalname: 'same.pdf',
        buffer,
        size: buffer.length,
      } as Express.Multer.File, 'Same content', user);
      await createStarted;

      const pendingFilename = prisma.material.create.mock.calls[0][0].data.filename;
      expect(pendingFilename).not.toBe(legacyFilename);
      const pendingFilePath = path.join(root, ...pendingFilename.split('/'));
      expect(fs.existsSync(pendingFilePath)).toBe(true);

      await service.remove('legacy-material', user);
      expect(fs.existsSync(legacyFilePath)).toBe(false);
      expect(fs.existsSync(pendingFilePath)).toBe(true);

      releaseCreate();
      await expect(uploadPromise).resolves.toEqual({
        data: expect.objectContaining({
          id: 'new-material',
          filename: pendingFilename,
        }),
        message: expect.any(String),
      });
      expect(fs.existsSync(pendingFilePath)).toBe(true);
    } finally {
      releaseCreate?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes the unique file when database creation fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'materials-compensate-'));
    process.env.UPLOADS_DIR = root;
    const buffer = Buffer.from('%PDF-1.4 create failure');
    const prisma: any = {
      material: {
        create: jest.fn().mockRejectedValue(new Error('database unavailable')),
      },
    };
    const service = new MaterialsService(prisma);

    try {
      await expect(service.upload({
        originalname: 'failure.pdf',
        buffer,
        size: buffer.length,
      } as Express.Multer.File, 'Failure', {
        id: 'admin-a',
        activeCompanyId: 'tenant-a',
        activeCompany: { id: 'tenant-a', role: 'company_admin' },
      })).rejects.toThrow('database unavailable');

      expect(fs.readdirSync(path.join(root, 'tenant-a'))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
