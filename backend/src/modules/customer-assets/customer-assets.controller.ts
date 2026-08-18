import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { requireActiveCompany, type CurrentUser as RequestUser } from '../../common/utils/data-isolation';
import type { MergeFieldChoice } from '../customer-identity/dto/merge-customer.dto';
import { CustomerAssetsService } from './customer-assets.service';

function companyIdOf(user: RequestUser): string {
  try {
    return requireActiveCompany(user).id;
  } catch {
    throw new ForbiddenException('An active company is required');
  }
}

@ApiTags('Customer Assets')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('customer-assets')
export class CustomerAssetsController {
  constructor(private readonly service: CustomerAssetsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get the customer asset aggregate' })
  get(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.service.getCustomerAsset(companyIdOf(user), id, user);
  }

  @Get(':id/contacts')
  @ApiOperation({ summary: 'List contacts and channel identities for a customer' })
  listContacts(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.service.listContacts(companyIdOf(user), id, user);
  }

  @Post('duplicate-check')
  @ApiOperation({ summary: 'Find same-tenant exact identity matches' })
  duplicateCheck(
    @Body() body: { leadId: string; phone?: string; email?: string; companyName?: string },
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.duplicateCheck({ companyId: companyIdOf(user), ...body });
  }
}

@ApiTags('Identity Candidates')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('identity-candidates')
export class IdentityCandidatesController {
  constructor(private readonly service: CustomerAssetsService) {}

  @Post(':id/merge-preview')
  mergePreview(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.service.mergePreview(companyIdOf(user), id, user);
  }

  @Post(':id/merge')
  merge(
    @Param('id') id: string,
    @Body() body: {
      targetUpdatedAt?: string;
      mode?: 'trusted_defaults' | 'field_choices';
      fieldChoices?: MergeFieldChoice[];
      adoptFields?: string[];
    },
    @CurrentUser() user: RequestUser,
  ) {
    const companyId = companyIdOf(user);
    return this.service.merge(companyId, {
      companyId,
      candidateId: id,
      targetUpdatedAt: body.targetUpdatedAt ?? '',
      mode: body.mode ?? (body.adoptFields?.length ? 'field_choices' : 'trusted_defaults'),
      fieldChoices: body.fieldChoices ?? (body.adoptFields ?? []).map((field) => ({
        field: field as MergeFieldChoice['field'],
        winner: 'source' as const,
      })),
    }, user);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() body: { reason?: string }, @CurrentUser() user: RequestUser) {
    return this.service.reject(companyIdOf(user), {
      companyId: companyIdOf(user), actorId: user.id, candidateId: id, reason: body.reason,
    }, user).then(() => ({ ok: true }));
  }
}

@ApiTags('Customer Merges')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('customer-merges')
export class CustomerMergesController {
  constructor(private readonly service: CustomerAssetsService) {}

  @Post(':id/undo')
  undo(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.service.undo(companyIdOf(user), id, user).then(() => ({ ok: true }));
  }
}
