import { Injectable, BadRequestException, NotFoundException, Logger, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { requireActiveCompany } from '../../common/utils/data-isolation';

const sharp = require('sharp');

export function getMaterialsUploadDir(): string {
  return path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
}

@Injectable()
export class MaterialsService {
  private readonly logger = new Logger(MaterialsService.name);
  private readonly uploadDir: string;

  constructor(private prisma: PrismaService) {
    this.uploadDir = getMaterialsUploadDir();
    if (!fs.existsSync(this.uploadDir)) fs.mkdirSync(this.uploadDir, { recursive: true });
  }

  async findAll(currentUser: any) {
    const companyId = requireActiveCompany(currentUser).id;
    const items = await this.prisma.material.findMany({
      where: { companyId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return { data: items };
  }

  async upload(file: Express.Multer.File, name: string, currentUser: any) {
    if (!file) throw new BadRequestException('No file provided');

    const companyId = this.requireTenantManager(currentUser);

    const ext = path.extname(file.originalname).toLowerCase();
    const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext);
    const isPdf = ext === '.pdf';

    if (!isImage && !isPdf) {
      throw new BadRequestException('Only images (JPG/PNG/GIF/WebP) and PDF files are allowed');
    }

    if (isPdf && file.size > 10 * 1024 * 1024) {
      throw new BadRequestException('PDF file size cannot exceed 10MB');
    }

    const tenantDirectory = path.join(this.uploadDir, companyId);
    fs.mkdirSync(tenantDirectory, { recursive: true, mode: 0o750 });
    const storageId = crypto.randomUUID();
    let filename: string;
    let fileSize: number;
    let compressed = false;

    if (isImage) {
      // Auto-compress images using sharp
      const compressedBuffer = await sharp(file.buffer)
        .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80, progressive: true })
        .toBuffer();

      filename = path.posix.join(companyId, `${storageId}.jpg`);
      fs.writeFileSync(this.resolveMaterialPath(filename), compressedBuffer);
      fileSize = compressedBuffer.length;
      compressed = file.buffer.length !== compressedBuffer.length;
      this.logger.log(`Image compressed: ${(file.buffer.length/1024).toFixed(1)}KB → ${(fileSize/1024).toFixed(1)}KB`);
    } else {
      // PDF — no compression, just save
      filename = path.posix.join(companyId, `${storageId}${ext}`);
      fs.writeFileSync(this.resolveMaterialPath(filename), file.buffer);
      fileSize = file.size;
    }

    let material: any;
    try {
      material = await this.prisma.material.create({
        data: {
          companyId,
          name: name || file.originalname,
          filename,
          originalName: file.originalname,
          mimeType: isImage ? 'image/jpeg' : 'application/pdf',
          size: fileSize,
          type: isImage ? 'image' : 'pdf',
          compressed,
          uploadedBy: currentUser.id,
        },
      });
    } catch (error) {
      this.unlinkMaterialFile(filename);
      throw error;
    }

    return { data: material, message: compressed ? '图片已自动压缩' : '上传成功' };
  }

  async remove(id: string, currentUser: any) {
    const companyId = this.requireTenantManager(currentUser);
    const material = await this.prisma.material.findFirst({
      where: { id, companyId, deletedAt: null },
    });
    if (!material) throw new NotFoundException('Material not found');

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.material.updateMany({
        where: { id, companyId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (updated.count !== 1) throw new NotFoundException('Material not found');
    }, { isolationLevel: 'Serializable' });

    if (this.isUniqueMaterialFilename(material.filename, companyId)) {
      this.unlinkMaterialFile(material.filename);
    } else {
      // Legacy content-hash paths may still be shared by existing rows. New
      // uploads never use these names, so a post-commit reference check cannot
      // race with creation of another shared path through this service.
      const activeLegacyReferences = await this.prisma.material.count({
        where: {
          filename: material.filename,
          deletedAt: null,
        },
      });
      if (activeLegacyReferences === 0) {
        this.unlinkMaterialFile(material.filename);
      }
    }
    return { message: 'Deleted' };
  }

  private isUniqueMaterialFilename(filename: string, companyId: string) {
    return path.posix.dirname(filename) === companyId
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|pdf)$/i
        .test(path.posix.basename(filename));
  }

  private unlinkMaterialFile(filename: string) {
    const filePath = this.resolveMaterialPath(filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  private resolveMaterialPath(filename: string) {
    const root = path.resolve(this.uploadDir);
    const candidate = path.resolve(root, filename);
    const relative = path.relative(root, candidate);
    if (
      !relative
      || relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      throw new BadRequestException('Invalid material file path');
    }
    return candidate;
  }

  private requireTenantManager(currentUser: any) {
    const active = requireActiveCompany(currentUser);
    if (!['super_admin', 'company_admin', 'sales_manager'].includes(active.role)) {
      throw new ForbiddenException('A tenant manager role is required');
    }
    return active.id;
  }
}
