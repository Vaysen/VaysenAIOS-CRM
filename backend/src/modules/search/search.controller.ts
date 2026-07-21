import {
  Controller, Get, Post, Param, Body, UseGuards, Req, Query, HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { SearchService } from './search.service';
import { CreateSearchTaskDto } from './dto/create-search-task.dto';
import { hasFullAccess } from '@/common/utils/data-isolation';

function isAdminRole(req: any): boolean {
  return hasFullAccess(req.user);
}

@ApiTags('AI 客户搜索')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Post('tasks')
  async createTask(@Body() dto: CreateSearchTaskDto, @Req() req: any) {
    return this.searchService.createTask(dto, req.user.id, req.user.companies[0]?.id);
  }

  @Get('tasks')
  listTasks(@Req() req: any) {
    const userId = isAdminRole(req) ? undefined : req.user.id;
    return this.searchService.listTasks(req.user.companies[0]?.id, userId);
  }

  @Get('queue-status')
  getQueueStatus(@Req() req: any) {
    const userId = isAdminRole(req) ? undefined : req.user.id;
    return this.searchService.getQueueStatus(req.user.companies[0]?.id, userId);
  }

  @Get('rate-limit')
  getRateLimit(@Req() req: any) {
    return this.searchService.getRateLimit(req.user.id);
  }

  @Get('tasks/:id')
  getTask(@Param('id') id: string, @Req() req: any) {
    const userId = isAdminRole(req) ? undefined : req.user.id;
    return this.searchService.getTask(id, req.user.companies[0]?.id, userId);
  }

  @Get('tasks/:id/results')
  getResults(@Param('id') id: string, @Req() req: any) {
    const userId = isAdminRole(req) ? undefined : req.user.id;
    return this.searchService.getResults(id, req.user.companies[0]?.id, userId);
  }

  @Post('tasks/:id/cancel')
  @HttpCode(200)
  cancelTask(@Param('id') id: string, @Req() req: any) {
    return this.searchService.cancelTask(id, req.user.companies[0]?.id, req.user.id);
  }

  @Post('tasks/:id/stop')
  @HttpCode(200)
  stopTask(@Param('id') id: string, @Req() req: any) {
    return this.searchService.stopTask(id, req.user.companies[0]?.id, req.user.id);
  }

  @Post('tasks/:id/convert-all')
  convertTaskResults(@Param('id') id: string, @Req() req: any) {
    return this.searchService.convertTaskResults(
      id,
      req.user.companies[0]?.id,
      req.user.id,
    );
  }

  @Post('results/:id/verify-email')
  verifyResultEmail(@Param('id') id: string, @Req() req: any) {
    return this.searchService.verifyResultEmail(id, req.user.companies[0]?.id);
  }

  @Post('results/verify-review-batch')
  verifyReviewBatch(@Body() body: { taskId?: string; resultIds?: string[] }, @Req() req: any) {
    return this.searchService.verifyReviewBatch(
      body || {},
      req.user.companies[0]?.id,
      req.user.id,
    );
  }

  @Post('results/:id/deep-research')
  deepResearch(@Param('id') id: string, @Req() req: any) {
    return this.searchService.deepResearch(id, req.user.companies[0]?.id);
  }

  @Post('results/:id/convert')
  convertToLead(@Param('id') id: string, @Body() body: { force?: boolean }, @Req() req: any) {
    return this.searchService.convertToLead(
      id,
      req.user.companies[0]?.id,
      req.user.id,
      body?.force ?? false,
    );
  }

  @Post('results/:id/similar')
  findSimilarBrands(@Param('id') id: string, @Req() req: any) {
    return this.searchService.createSimilarBrandsTask(id, req.user.companies[0]?.id, req.user.id);
  }
}
