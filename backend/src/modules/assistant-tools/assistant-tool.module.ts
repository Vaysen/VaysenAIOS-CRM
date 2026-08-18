import { Module } from '@nestjs/common';
import { CustomerAssetsModule } from '../customer-assets/customer-assets.module';
import { TimelineModule } from '../timeline/timeline.module';
import { QuotesModule } from '../quotes/quotes.module';
import { OrdersModule } from '../orders/orders.module';
import { AssistantToolController } from './assistant-tool.controller';
import { AssistantToolService } from './assistant-tool.service';

@Module({
  imports: [CustomerAssetsModule, TimelineModule, QuotesModule, OrdersModule],
  controllers: [AssistantToolController],
  providers: [AssistantToolService],
  exports: [AssistantToolService],
})
export class AssistantToolModule {}
