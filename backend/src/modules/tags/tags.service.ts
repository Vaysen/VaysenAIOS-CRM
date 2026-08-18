import { Injectable, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { requireActiveCompany } from '@/common/utils/data-isolation';

@Injectable()
export class TagsService {
  constructor(private prisma: PrismaService) {}

  async findAll(currentUser: any) {
    const companyId = requireActiveCompany(currentUser).id;
    const tags = await this.prisma.tag.findMany({
      where: { companyId },
      orderBy: [{ category: 'asc' }, { displayName: 'asc' }],
    });
    return { data: tags };
  }

  async create(dto: { name: string; color?: string }, currentUser: any) {
    const companyId = this.requireTenantManager(currentUser);

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
    const companyId = this.requireTenantManager(currentUser);
    const tag = await this.prisma.tag.findFirst({ where: { id, companyId } });
    if (!tag) throw new NotFoundException('Tag not found');
    if (tag.isSystem) throw new ForbiddenException('Cannot delete system tags');

    await this.prisma.tag.delete({ where: { id } });
    return { message: 'Tag deleted' };
  }

  async addTagsToLead(
    leadId: string,
    tagIds: string[],
    userId: string,
    companyId: string,
  ) {
    const tags = await this.prisma.tag.findMany({
      where: { id: { in: tagIds }, companyId },
      select: { id: true },
    });
    if (tags.length !== new Set(tagIds).size) {
      throw new ForbiddenException('One or more tags are outside the active company');
    }
    const data = tagIds.map((tagId) => ({ leadId, tagId, createdBy: userId }));
    await this.prisma.leadTag.createMany({ data, skipDuplicates: true });
    return { message: 'Tags added' };
  }

  async removeTagFromLead(leadId: string, tagId: string, companyId: string) {
    const tag = await this.prisma.tag.findFirst({
      where: { id: tagId, companyId },
      select: { id: true },
    });
    if (!tag) throw new NotFoundException('Tag not found');
    await this.prisma.leadTag.deleteMany({ where: { leadId, tagId } });
    return { message: 'Tag removed' };
  }

  async syncLeadTags(leadId: string, tagIds: string[], userId: string, companyId: string) {
    // Remove all existing tags for this lead
    await this.prisma.leadTag.deleteMany({ where: { leadId } });
    // Add new tags
    if (tagIds.length > 0) {
      await this.addTagsToLead(leadId, tagIds, userId, companyId);
    }
  }

  private requireTenantManager(currentUser: any) {
    const active = requireActiveCompany(currentUser);
    if (!['super_admin', 'company_admin', 'sales_manager'].includes(active.role)) {
      throw new ForbiddenException('A tenant manager role is required');
    }
    return active.id;
  }
}
