import { Injectable, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';

@Injectable()
export class TagsService {
  constructor(private prisma: PrismaService) {}

  async findAll(currentUser: any) {
    const companyIds = currentUser.companies?.map((c: any) => c.id) || [];
    const tags = await this.prisma.tag.findMany({
      where: { companyId: { in: companyIds } },
      orderBy: [{ category: 'asc' }, { displayName: 'asc' }],
    });
    return { data: tags };
  }

  async create(dto: { name: string; color?: string }, currentUser: any) {
    const companyId = currentUser.companies?.[0]?.id;
    if (!companyId) throw new ForbiddenException('No company associated');

    const name = dto.name.trim();
    if (!name) throw new ForbiddenException('Tag name is required');

    const existing = await this.prisma.tag.findUnique({
      where: { companyId_name: { companyId, name } },
    });
    if (existing) throw new ConflictException('Tag already exists');

    const tag = await this.prisma.tag.create({
      data: {
        companyId,
        name,
        displayName: name,
        color: dto.color || '#6366f1',
        category: 'custom',
        isSystem: false,
      },
    });
    return tag;
  }

  async remove(id: string, currentUser: any) {
    const tag = await this.prisma.tag.findUnique({ where: { id } });
    if (!tag) throw new NotFoundException('Tag not found');
    if (tag.isSystem) throw new ForbiddenException('Cannot delete system tags');

    const companyIds = currentUser.companies?.map((c: any) => c.id) || [];
    if (!companyIds.includes(tag.companyId)) throw new ForbiddenException('Cannot delete tags from another company');

    await this.prisma.tag.delete({ where: { id } });
    return { message: 'Tag deleted' };
  }

  async addTagsToLead(leadId: string, tagIds: string[], userId: string) {
    const data = tagIds.map((tagId) => ({ leadId, tagId, createdBy: userId }));
    await this.prisma.leadTag.createMany({ data, skipDuplicates: true });
    return { message: 'Tags added' };
  }

  async removeTagFromLead(leadId: string, tagId: string) {
    await this.prisma.leadTag.deleteMany({ where: { leadId, tagId } });
    return { message: 'Tag removed' };
  }

  async syncLeadTags(leadId: string, tagIds: string[], userId: string) {
    // Remove all existing tags for this lead
    await this.prisma.leadTag.deleteMany({ where: { leadId } });
    // Add new tags
    if (tagIds.length > 0) {
      await this.addTagsToLead(leadId, tagIds, userId);
    }
  }
}
