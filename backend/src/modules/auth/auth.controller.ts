import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshDto } from './dto/refresh.dto';
import { InitializeAdminDto } from './dto/initialize-admin.dto';
import { Public } from '../../common/decorators/public.decorator';
import {
  assertFixedWindowRateLimit,
  assertTrustedCookieOrigin,
  envLimit,
  getCookie,
  getRequestIp,
} from '../../common/security/request-security';

const REFRESH_COOKIE = 'vaysen_refresh';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'User login' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.rateLimit('login', req, 'AUTH_LOGIN_RATE_LIMIT', 10);
    this.assertInitialAuthTransport(req);
    const result = await this.authService.login(dto);
    return this.deliverTokens(req, res, result);
  }

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'User registration (disabled by default)' })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.rateLimit('register', req, 'AUTH_REGISTER_RATE_LIMIT', 3);
    this.assertInitialAuthTransport(req);
    const result = await this.authService.register(dto);
    return this.deliverTokens(req, res, result);
  }

  @Public()
  @Post('initialize')
  @ApiOperation({ summary: 'One-time initial company administrator setup' })
  async initialize(
    @Body() dto: InitializeAdminDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.rateLimit('initialize', req, 'AUTH_INITIALIZE_RATE_LIMIT', 5);
    this.assertInitialAuthTransport(req);
    const result = await this.authService.initialize(dto);
    return this.deliverTokens(req, res, result);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate refresh token' })
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.rateLimit('refresh', req, 'AUTH_REFRESH_RATE_LIMIT', 30);
    const resolved = this.resolveRefreshToken(req, dto?.refreshToken);
    const result = await this.authService.refresh(resolved.token);
    if (resolved.mode === 'cookie') {
      this.setRefreshCookie(res, result.refreshToken);
      return this.withoutRefreshToken(result);
    }
    return result;
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  getProfile(@Req() req: any) {
    return this.authService.getProfile(req.user.id);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout current user' })
  async logout(
    @Req() req: any,
    @Body() dto: RefreshDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const resolved = this.resolveRefreshToken(req, dto?.refreshToken, true);
    const result = await this.authService.logout(req.user.id, resolved.token);
    if (resolved.mode === 'cookie') {
      this.clearRefreshCookie(res);
    }
    return result;
  }

  private deliverTokens(req: any, res: Response, result: any) {
    if (this.isBodyTokenMode(req)) {
      return result;
    }
    this.setRefreshCookie(res, result.refreshToken);
    return this.withoutRefreshToken(result);
  }

  private resolveRefreshToken(
    req: any,
    bodyToken?: string,
    allowMissing = false,
  ): { token: string; mode: 'cookie' | 'body' } {
    const cookieToken = getCookie(req, REFRESH_COOKIE);
    if (cookieToken && bodyToken) {
      throw new BadRequestException(
        'Provide the refresh token using either the cookie or request body, not both',
      );
    }
    if (cookieToken) {
      assertTrustedCookieOrigin(req);
      return { token: cookieToken, mode: 'cookie' };
    }
    if (bodyToken) {
      if (!this.isBodyTokenMode(req)) {
        throw new BadRequestException(
          'Request-body refresh tokens require the explicit non-browser token mode',
        );
      }
      return { token: bodyToken, mode: 'body' };
    }
    if (allowMissing) {
      return { token: '', mode: 'body' };
    }
    throw new BadRequestException('Refresh token required');
  }

  private isBodyTokenMode(req: any) {
    const requested = String(
      req?.headers?.['x-refresh-token-mode'] || '',
    ).toLowerCase() === 'body';
    if (!requested) return false;
    if (String(req?.headers?.origin || '').trim()) {
      throw new BadRequestException(
        'Browser-origin requests must use the HttpOnly refresh-token cookie',
      );
    }
    return true;
  }

  private assertInitialAuthTransport(req: any) {
    if (this.isBodyTokenMode(req)) return;
    assertTrustedCookieOrigin(req);
  }

  private setRefreshCookie(res: Response, refreshToken: string) {
    res.cookie(REFRESH_COOKIE, refreshToken, {
      ...this.refreshCookieOptions(),
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  private clearRefreshCookie(res: Response) {
    res.clearCookie(REFRESH_COOKIE, this.refreshCookieOptions());
  }

  private refreshCookieOptions() {
    const production = process.env.NODE_ENV === 'production'
      && process.env.APP_MODE !== 'preview'
      && process.env.APP_MODE !== 'development';
    const configuredSameSite = String(
      process.env.AUTH_COOKIE_SAME_SITE || 'strict',
    ).toLowerCase();
    return {
      httpOnly: true,
      secure: production || process.env.AUTH_COOKIE_SECURE === 'true',
      sameSite: configuredSameSite === 'lax'
        ? 'lax' as const
        : 'strict' as const,
      path: '/api/auth',
    };
  }

  private withoutRefreshToken(result: any) {
    const { refreshToken: _refreshToken, ...safe } = result;
    return safe;
  }

  private rateLimit(
    scope: string,
    req: any,
    envName: string,
    fallback: number,
  ) {
    assertFixedWindowRateLimit(
      `auth.${scope}`,
      getRequestIp(req),
      envLimit(envName, fallback, 1, 1000),
      15 * 60 * 1000,
    );
  }
}
