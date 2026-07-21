import { Controller, Get, Param, Query, Req, Res, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { EmailTrackService } from './email-track.service';

@ApiTags('Email Tracking')
@Controller('email-track')
export class EmailTrackController {
  constructor(private readonly emailTrackService: EmailTrackService) {}

  @Public()
  @Get('open/:trackingId')
  @ApiOperation({ summary: 'Email open tracking pixel — returns 1x1 transparent GIF' })
  async trackOpen(
    @Param('trackingId') trackingId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ipAddress = (req.headers['x-forwarded-for'] as string) || req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] as string;

    const pixel = await this.emailTrackService.trackOpen(trackingId, ipAddress, userAgent);

    res.set({
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.status(HttpStatus.OK).send(pixel);
  }

  @Public()
  @Get('click/:trackingId')
  @ApiOperation({ summary: 'Email click tracking redirect' })
  @ApiQuery({ name: 'url', required: true, description: 'Original URL to redirect to' })
  async trackClick(
    @Param('trackingId') trackingId: string,
    @Query('url') originalUrl: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ipAddress = (req.headers['x-forwarded-for'] as string) || req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] as string;

    const redirectUrl = await this.emailTrackService.trackClick(
      trackingId,
      decodeURIComponent(originalUrl),
      ipAddress,
      userAgent,
    );

    res.redirect(HttpStatus.FOUND, redirectUrl);
  }
}
