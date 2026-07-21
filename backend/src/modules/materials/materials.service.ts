import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

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
    const companyIds = currentUser.companies?.map((c: any) => c.id) || [];
    const items = await this.prisma.material.findMany({
      where: { companyId: { in: companyIds }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return { data: items };
  }

  async upload(file: Express.Multer.File, name: string, currentUser: any) {
    if (!file) throw new BadRequestException('No file provided');

    const companyId = currentUser.companies?.[0]?.id;
    if (!companyId) throw new ForbiddenException('No company');

    const ext = path.extname(file.originalname).toLowerCase();
    const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext);
    const isPdf = ext === '.pdf';

    if (!isImage && !isPdf) {
      throw new BadRequestException('Only images (JPG/PNG/GIF/WebP) and PDF files are allowed');
    }

    if (isPdf && file.size > 10 * 1024 * 1024) {
      throw new BadRequestException('PDF file size cannot exceed 10MB');
    }

    const hash = crypto.createHash('md5').update(file.buffer).digest('hex').slice(0, 12);
    let filename: string;
    let fileSize: number;
    let compressed = false;

    if (isImage) {
      // Auto-compress images using sharp
      const compressedBuffer = await sharp(file.buffer)
        .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80, progressive: true })
        .toBuffer();

      filename = `${hash}.jpg`;
      fs.writeFileSync(path.join(this.uploadDir, filename), compressedBuffer);
      fileSize = compressedBuffer.length;
      compressed = file.buffer.length !== compressedBuffer.length;
      this.logger.log(`Image compressed: ${(file.buffer.length/1024).toFixed(1)}KB → ${(fileSize/1024).toFixed(1)}KB`);
    } else {
      // PDF — no compression, just save
      filename = `${hash}${ext}`;
      fs.writeFileSync(path.join(this.uploadDir, filename), file.buffer);
      fileSize = file.size;
    }

    const material = await this.prisma.material.create({
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

    return { data: material, message: compressed ? '图片已自动压缩' : '上传成功' };
  }

  async remove(id: string, currentUser: any) {
    const material = await this.prisma.material.findUnique({ where: { id } });
    if (!material) throw new NotFoundException('Material not found');
    const companyIds = currentUser.companies?.map((c: any) => c.id) || [];
    if (!companyIds.includes(material.companyId)) throw new ForbiddenException();

    // Delete file
    const filePath = path.join(this.uploadDir, material.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await this.prisma.material.update({ where: { id }, data: { deletedAt: new Date() } });
    return { message: 'Deleted' };
  }
}
