import { Module } from '@nestjs/common';
import { CustomerIdentityModule } from '../customer-identity/customer-identity.module';
import {
  CustomerAssetsController,
  IdentityCandidatesController,
  CustomerMergesController,
} from './customer-assets.controller';
import { CustomerAssetsService } from './customer-assets.service';

@Module({
  imports: [CustomerIdentityModule],
  controllers: [
    CustomerAssetsController,
    IdentityCandidatesController,
    CustomerMergesController,
  ],
  providers: [CustomerAssetsService],
  exports: [CustomerAssetsService],
})
export class CustomerAssetsModule {}
