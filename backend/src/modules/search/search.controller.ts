import {
  Controller, Get, Post, Param, Body, UseGuards, Req, Query, HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { SearchService } from './search.service';
import { CreateSearchTaskDto } from './dto/create-search-task.dto';
import {
  hasFullAccess,
  requireActiveCompany,
} from '@/common/utils/data-isolation';

function activeCompanyId(req: any): string {
  return requireActiveCompany(req.user).id;
}

function isAdminRole(req: any, companyId: string): boolean {
  return hasFullAccess(req.user, companyId);
}

@ApiTags('AI 客户搜索')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Post('tasks')
  async createTask(@Body() dto: CreateSearchTaskDto, @Req() req: any) {
    return this.searchService.createTask(dto, req.user.id, activeCompanyId(req));
  }

  @Get('tasks')
  listTasks(@Req() req: any) {
    const companyId = activeCompanyId(req);
    const userId = isAdminRole(req, companyId) ? undefined : req.user.id;
    return this.searchService.listTasks(companyId, userId);
  }

  @Get('queue-status')
  getQueueStatus(@Req() req: any) {
    const companyId = activeCompanyId(req);
    const userId = isAdminRole(req, companyId) ? undefined : req.user.id;
    return this.searchService.getQueueStatus(companyId, userId);
  }

  @Get('rate-limit')
  getRateLimit(@Req() req: any) {
    return this.searchService.getRateLimit(req.user.id);
  }

  @Get('tasks/:id')
  getTask(@Param('id') id: string, @Req() req: any) {
    const companyId = activeCompanyId(req);
    const userId = isAdminRole(req, companyId) ? undefined : req.user.id;
    return this.searchService.getTask(id, companyId, userId);
  }

  @Get('tasks/:id/results')
  getResults(@Param('id') id: string, @Req() req: any) {
    const companyId = activeCompanyId(req);
    const userId = isAdminRole(req, companyId) ? undefined : req.user.id;
    return this.searchService.getResults(id, companyId, userId);
  }

  @Post('tasks/:id/cancel')
  @HttpCode(200)
  cancelTask(@Param('id') id: string, @Req() req: any) {
    return this.searchService.cancelTask(id, activeCompanyId(req), req.user.id);
  }

  @Post('tasks/:id/stop')
  @HttpCode(200)
  stopTask(@Param('id') id: string, @Req() req: any) {
    return this.searchService.stopTask(id, activeCompanyId(req), req.user.id);
  }

  @Post('tasks/:id/convert-all')
  convertTaskResults(@Param('id') id: string, @Req() req: any) {
    return this.searchService.convertTaskResults(
      id,
      activeCompanyId(req),
      req.user.id,
    );
  }

  @Post('results/:id/verify-email')
  verifyResultEmail(@Param('id') id: string, @Req() req: any) {
    return this.searchService.verifyResultEmail(id, activeCompanyId(req));
  }

  @Post('results/verify-review-batch')
  verifyReviewBatch(@Body() body: { taskId?: string; resultIds?: string[] }, @Req() req: any) {
    return this.searchService.verifyReviewBatch(
      body || {},
      activeCompanyId(req),
      req.user.id,
    );
  }

  @Post('results/:id/deep-research')
  deepResearch(@Param('id') id: string, @Req() req: any) {
    return this.searchService.deepResearch(id, activeCompanyId(req));
  }

  @Post('results/:id/convert')
  convertToLead(@Param('id') id: string, @Body() body: { force?: boolean }, @Req() req: any) {
    return this.searchService.convertToLead(
      id,
      activeCompanyId(req),
      req.user.id,
      body?.force ?? false,
    );
  }

  @Post('results/:id/similar')
  findSimilarBrands(@Param('id') id: string, @Req() req: any) {
    return this.searchService.createSimilarBrandsTask(
      id,
      activeCompanyId(req),
      req.user.id,
    );
  }
}
