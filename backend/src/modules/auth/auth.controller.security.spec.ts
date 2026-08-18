import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { AuthController } from './auth.controller';
import { resetRateLimitsForTests } from '../../common/security/request-security';

  describe('AuthController refresh-token transport security', () => {
  const tokenResult = {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresIn: 900,
    user: { id: 'u1' },
  };
  let auth: any;
  let controller: AuthController;

  beforeEach(() => {
    resetRateLimitsForTests();
    process.env.NODE_ENV = 'production';
    process.env.APP_MODE = 'production';
    process.env.FRONTEND_URL = 'https://crm.example.test';
    process.env.AUTH_COOKIE_SAME_SITE = 'strict';
    auth = {
      login: jest.fn().mockResolvedValue(tokenResult),
      refresh: jest.fn().mockResolvedValue(tokenResult),
      logout: jest.fn().mockResolvedValue({ message: 'ok' }),
    };
    controller = new AuthController(auth);
  });

  it('rejects ambiguous cookie and body refresh tokens', async () => {
    await expect(controller.refresh(
      { refreshToken: 'body-token' },
      {
        ip: '127.0.0.1',
        headers: {
          cookie: 'vaysen_refresh=cookie-token',
          origin: 'https://crm.example.test',
        },
      },
      {} as any,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(auth.refresh).not.toHaveBeenCalled();
  });

    it('requires an exact trusted Origin for cookie refresh', async () => {
    await expect(controller.refresh(
      {},
      {
        ip: '127.0.0.1',
        headers: {
          cookie: 'vaysen_refresh=cookie-token',
          origin: 'https://evil.example',
        },
      },
      {} as any,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('rejects cookie-mode login from an untrusted Origin before credential lookup', async () => {
    await expect(controller.login(
      { email: 'u@example.test', password: 'password-password' },
      {
        ip: '127.0.0.1',
        headers: { origin: 'https://evil.example' },
      },
      { cookie: jest.fn() } as any,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('uses matching security attributes when setting and clearing the cookie', async () => {
    const loginResponse = { cookie: jest.fn() } as any;
    await controller.login(
      { email: 'u@example.test', password: 'password-password' },
      {
        ip: '127.0.0.1',
        headers: { origin: 'https://crm.example.test' },
      },
      loginResponse,
    );
    const setOptions = loginResponse.cookie.mock.calls[0][2];

    const logoutResponse = { clearCookie: jest.fn() } as any;
    await controller.logout(
      {
        user: { id: 'u1' },
        headers: {
          cookie: 'vaysen_refresh=refresh',
          origin: 'https://crm.example.test',
        },
      },
      {},
      logoutResponse,
    );
    const clearOptions = logoutResponse.clearCookie.mock.calls[0][1];

    expect(clearOptions).toEqual({
      httpOnly: setOptions.httpOnly,
      secure: setOptions.secure,
      sameSite: setOptions.sameSite,
      path: setOptions.path,
    });

    expect(clearOptions).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/auth',
    });
  });

  it('accepts either exact Vaysen LAN Origin from comma-separated CORS_ORIGIN', async () => {
    const previous = process.env.CORS_ORIGIN;
    process.env.CORS_ORIGIN = 'http://127.0.0.1,http://127.0.0.1';
    try {
      await controller.refresh(
        {},
        {
          ip: '127.0.0.1',
          headers: {
            origin: 'http://127.0.0.1',
            cookie: 'vaysen_refresh=cookie-token',
          },
        },
        { cookie: jest.fn() } as any,
      );
      expect(auth.refresh).toHaveBeenCalledWith('cookie-token');
    } finally {
      if (previous === undefined) delete process.env.CORS_ORIGIN;
      else process.env.CORS_ORIGIN = previous;
    }
  });

  it('keeps the explicit body-token mode for non-browser clients', async () => {
    const result = await controller.refresh(
      { refreshToken: 'desktop-token' },
      {
        ip: '127.0.0.1',
        headers: { 'x-refresh-token-mode': 'body' },
      },
      {} as any,
    );
    expect(result.refreshToken).toBe('refresh');
    expect(auth.refresh).toHaveBeenCalledWith('desktop-token');
  });

  it('does not let a query parameter downgrade login to JSON refresh tokens', async () => {
    const response = { cookie: jest.fn() } as any;
    const result = await controller.login(
      { email: 'u@example.test', password: 'password-password' },
      {
        ip: '127.0.0.1',
        headers: { origin: 'https://crm.example.test' },
        query: { source: 'desktop' },
      },
      response,
    );

    expect(result).not.toHaveProperty('refreshToken');
    expect(response.cookie).toHaveBeenCalledWith(
      'vaysen_refresh',
      'refresh',
      expect.objectContaining({ httpOnly: true }),
    );
  });

  it('rejects browser-origin login attempts that request body-token mode', async () => {
    await expect(controller.login(
      { email: 'u@example.test', password: 'password-password' },
      {
        ip: '127.0.0.1',
        headers: {
          origin: 'https://evil.example',
          'x-refresh-token-mode': 'body',
        },
      },
      {} as any,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('rejects browser-origin refresh downgrade even with the explicit header', async () => {
    await expect(controller.refresh(
      { refreshToken: 'stolen-token' },
      {
        ip: '127.0.0.1',
        headers: {
          origin: 'https://evil.example',
          'x-refresh-token-mode': 'body',
        },
      },
      {} as any,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('does not accept the legacy desktop query switch for body refresh tokens', async () => {
    await expect(controller.refresh(
      { refreshToken: 'desktop-token' },
      {
        ip: '127.0.0.1',
        headers: {},
        query: { source: 'desktop' },
      },
      {} as any,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('rotates a cookie refresh token without exposing it in JSON', async () => {
    const response = { cookie: jest.fn() } as any;
    const result = await controller.refresh(
      {},
      {
        ip: '127.0.0.1',
        headers: {
          cookie: 'vaysen_refresh=old-refresh',
          origin: 'https://crm.example.test',
        },
      },
      response,
    );

    expect(auth.refresh).toHaveBeenCalledWith('old-refresh');
    expect(result).not.toHaveProperty('refreshToken');
    expect(response.cookie).toHaveBeenCalledWith(
      'vaysen_refresh',
      'refresh',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
      }),
    );
  });
});
