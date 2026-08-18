import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MarketingPreferencesService } from './marketing-preferences.service';
import { UpsertConsentDto } from './dto/consent.dto';
import { AddSuppressionDto } from './dto/suppression.dto';

@ApiTags('Marketing Preferences')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('marketing-preferences')
export class MarketingPreferencesController {
  constructor(private readonly service: MarketingPreferencesService) {}

  @Get('leads/:leadId')
  leadPreferences(@Param('leadId') leadId: string, @CurrentUser() user: any) {
    return this.service.getLeadPreferences(leadId, user);
  }

  @Get('consents')
  listConsents(@CurrentUser() user: any) {
    return this.service.listConsents(user);
  }

  @Post('consents')
  upsertConsent(@Body() dto: UpsertConsentDto, @CurrentUser() user: any) {
    return this.service.upsertConsent(dto, user);
  }

  @Post('consents/:id/revoke')
  revokeConsent(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.revokeConsent(id, user);
  }

  @Get('suppressions')
  listSuppressions(@CurrentUser() user: any) {
    return this.service.listSuppressions(user);
  }

  @Post('suppressions')
  addSuppression(@Body() dto: AddSuppressionDto, @CurrentUser() user: any) {
    return this.service.addSuppression(dto, user);
  }

  @Post('suppressions/:id/remove')
  removeSuppression(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.removeSuppression(id, user);
  }
}
