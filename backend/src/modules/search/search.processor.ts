import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { QUEUES } from '@/common/queues/queue-names';
import { SearchService } from './search.service';

@Processor(QUEUES.prospectSearch, {
  concurrency: Number(process.env.PROSPECT_SEARCH_CONCURRENCY || 2),
  lockDuration: Number(process.env.PROSPECT_SEARCH_LOCK_MS || 60 * 60 * 1000),
  stalledInterval: Number(process.env.PROSPECT_SEARCH_STALLED_INTERVAL_MS || 60 * 1000),
  maxStalledCount: Number(process.env.PROSPECT_SEARCH_MAX_STALLED || 2),
})
export class SearchProcessor extends WorkerHost {
  private readonly logger = new Logger(SearchProcessor.name);

  constructor(private readonly searchService: SearchService) {
    super();
  }

  async process(job: Job<{ taskId: string; companyId?: string; keywords: string[]; targetCountry: string; customerType?: string; excludeWords: string[]; searchLanguage: string; maxResults: number }>) {
    this.logger.log(`Processing search job ${job.id} for task ${job.data.taskId}`);
    // Clean up stale running tasks to prevent queue blocking
    if (job.data.companyId) {
      await this.searchService.finalizeStaleRunningTasks(job.data.companyId).catch(() => {});
    }
    await this.searchService.executeSearch(job.data.taskId, job.data);
  }
}
