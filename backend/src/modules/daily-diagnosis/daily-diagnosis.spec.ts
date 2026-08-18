/**
 * R111 批次D：daily-diagnosis 单测（mock OpenClaw）。
 * 覆盖：当日快照幂等、GENERATING 防抖/残留接管、无快照生成（新工作日重算）、
 * OpenClaw 不可用 503 不落 FAILED、生成失败 FAILED + 502、regenerate 权限与重算、
 * 控制器 GET /daily-diagnosis/today 路由接线。
 */
import { BadGatewayException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { DailyDiagnosisService } from './daily-diagnosis.service';
import { DailyDiagnosisController } from './daily-diagnosis.controller';

const ADMIN = {
  id: 'user-1',
  activeCompanyId: 'comp-1',
  activeCompany: { id: 'comp-1', role: 'company_admin' },
  companies: [{ id: 'comp-1', role: 'company_admin' }],
};
const SALES = {
  id: 'user-2',
  activeCompanyId: 'comp-1',
  activeCompany: { id: 'comp-1', role: 'sales_user' },
  companies: [{ id: 'comp-1', role: 'sales_user' }],
};

const VALID_CONTENT = JSON.stringify({
  healthScore: 78,
  summary: '整体运营平稳，需关注高价值客户跟进',
  highlights: ['本周新线索 12 条', '邮件打开率提升至 45%'],
  risks: ['客户 Alpha 连续 7 天未回复'],
  recommendations: [{ priority: 'P1', title: '跟进 Alpha', reason: '沉默超一周', action: '电话回访' }],
});

function makeRow(overrides: Record<string, any> = {}) {
  return {
    id: 'diag-1',
    companyId: 'comp-1',
    diagnosisDate: new Date('2026-08-18T00:00:00.000Z'),
    status: 'COMPLETED',
    healthScore: 78,
    summary: '整体运营平稳',
    highlights: ['h1'],
    risks: ['r1'],
    recommendations: [{ priority: 'P1', title: 't', reason: 'r', action: 'a' }],
    metricsSnapshot: { overview: { totalLeads: 10 } },
    lastError: null,
    createdAt: new Date('2026-08-18T01:00:00.000Z'),
    updatedAt: new Date('2026-08-18T01:00:00.000Z'),
    ...overrides,
  };
}

function makeDeps(overrides: Record<string, any> = {}) {
  return {
    prisma: {
      dailyDiagnosis: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    },
    agent: { getBrief: jest.fn().mockResolvedValue({ metrics: { leads: 10 } }) },
    analytics: {
      getOverview: jest.fn().mockResolvedValue({ totalLeads: 10 }),
      getSources: jest.fn().mockResolvedValue({ sources: [] }),
      getWhatsappStats: jest.fn().mockResolvedValue({ conversations: 0 }),
    },
    execution: { getDeliveryRuns: jest.fn().mockResolvedValue({ runs: [], statusDistribution: [] }) },
    openclaw: {
      isEnabled: jest.fn().mockReturnValue(true),
      probe: jest.fn().mockResolvedValue({ gatewayReady: true, adapterReady: true, modelReady: true }),
      chat: jest.fn(),
    },
    ...overrides,
  };
}

function makeService(deps: ReturnType<typeof makeDeps>) {
  return new DailyDiagnosisService(
    deps.prisma as any,
    deps.agent as any,
    deps.analytics as any,
    deps.execution as any,
    deps.openclaw as any,
  );
}

describe('DailyDiagnosisService today (R111 批次D)', () => {
  it('returns the completed snapshot idempotently without calling OpenClaw', async () => {
    const deps = makeDeps();
    deps.prisma.dailyDiagnosis.findUnique.mockResolvedValue(makeRow());
    const service = makeService(deps);

    const result = await service.getToday(ADMIN);

    expect(result.status).toBe('COMPLETED');
    expect(result.diagnosisDate).toBe('2026-08-18');
    expect(deps.openclaw.chat).not.toHaveBeenCalled();
    expect(deps.prisma.dailyDiagnosis.create).not.toHaveBeenCalled();
    expect(deps.prisma.dailyDiagnosis.update).not.toHaveBeenCalled();
  });

  it('returns { generating: true } while a fresh GENERATING row is in progress (<10 min)', async () => {
    const deps = makeDeps();
    deps.prisma.dailyDiagnosis.findUnique.mockResolvedValue(
      makeRow({ status: 'GENERATING', updatedAt: new Date() }),
    );
    const service = makeService(deps);

    const result = await service.getToday(ADMIN);
    expect(result).toEqual({ generating: true });
    expect(deps.openclaw.chat).not.toHaveBeenCalled();
  });

  it('takes over a stale GENERATING row (>10 min) and regenerates', async () => {
    const deps = makeDeps();
    deps.prisma.dailyDiagnosis.findUnique.mockResolvedValue(
      makeRow({ status: 'GENERATING', updatedAt: new Date(Date.now() - 11 * 60 * 1000) }),
    );
    deps.prisma.dailyDiagnosis.update.mockResolvedValue(makeRow({ status: 'COMPLETED' }));
    deps.openclaw.chat.mockResolvedValue({ success: true, content: VALID_CONTENT });
    const service = makeService(deps);

    const result = await service.getToday(ADMIN);

    expect(deps.prisma.dailyDiagnosis.update).toHaveBeenCalled();
    expect(deps.openclaw.chat).toHaveBeenCalled();
    expect(result.status).toBe('COMPLETED');
  });

  it('creates a fresh snapshot when today has none (new workday) and persists metricsSnapshot', async () => {
    const deps = makeDeps();
    deps.prisma.dailyDiagnosis.findUnique.mockResolvedValue(null);
    deps.prisma.dailyDiagnosis.create.mockResolvedValue(makeRow({ status: 'GENERATING' }));
    deps.prisma.dailyDiagnosis.update.mockResolvedValue(makeRow({ status: 'COMPLETED' }));
    deps.openclaw.chat.mockResolvedValue({ success: true, content: VALID_CONTENT });
    const service = makeService(deps);

    const result = await service.getToday(ADMIN);

    expect(deps.prisma.dailyDiagnosis.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'GENERATING', companyId: 'comp-1' }) }),
    );
    const updateCall = deps.prisma.dailyDiagnosis.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe('COMPLETED');
    expect(updateCall.data.healthScore).toBe(78);
    expect(updateCall.data.highlights).toEqual(['本周新线索 12 条', '邮件打开率提升至 45%']);
    expect(updateCall.data.metricsSnapshot).toMatchObject({ overview: { totalLeads: 10 } });
    expect(result.status).toBe('COMPLETED');
  });

  it('returns 503 (ServiceUnavailable) when OpenClaw is disabled and never marks FAILED', async () => {
    const deps = makeDeps({
      openclaw: {
        isEnabled: jest.fn().mockReturnValue(false),
        probe: jest.fn(),
        chat: jest.fn(),
      },
    });
    deps.prisma.dailyDiagnosis.findUnique.mockResolvedValue(null);
    const service = makeService(deps);

    await expect(service.getToday(ADMIN)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(deps.prisma.dailyDiagnosis.create).not.toHaveBeenCalled();
    expect(deps.prisma.dailyDiagnosis.update).not.toHaveBeenCalled();
    expect(deps.openclaw.chat).not.toHaveBeenCalled();
  });

  it('marks FAILED and throws 502 when the model returns invalid JSON twice', async () => {
    const deps = makeDeps();
    deps.prisma.dailyDiagnosis.findUnique.mockResolvedValue(null);
    deps.prisma.dailyDiagnosis.create.mockResolvedValue(makeRow({ status: 'GENERATING' }));
    deps.prisma.dailyDiagnosis.update.mockResolvedValue(makeRow({ status: 'FAILED', lastError: 'diagnosis_invalid_json' }));
    deps.openclaw.chat.mockResolvedValue({ success: true, content: '这不是 JSON' });
    const service = makeService(deps);

    await expect(service.getToday(ADMIN)).rejects.toBeInstanceOf(BadGatewayException);
    expect(deps.openclaw.chat).toHaveBeenCalledTimes(2); // 失败重试 1 次
    const updateCall = deps.prisma.dailyDiagnosis.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe('FAILED');
    expect(updateCall.data.lastError).toBe('diagnosis_invalid_json');
  });
});

describe('DailyDiagnosisService regenerate (R111 批次D)', () => {
  it('rejects non-admin users', async () => {
    const deps = makeDeps();
    deps.prisma.dailyDiagnosis.findUnique.mockResolvedValue(makeRow());
    const service = makeService(deps);

    await expect(service.regenerate(SALES)).rejects.toBeInstanceOf(ForbiddenException);
    expect(deps.openclaw.chat).not.toHaveBeenCalled();
  });

  it('regenerates today snapshot for company admin', async () => {
    const deps = makeDeps();
    deps.prisma.dailyDiagnosis.findUnique.mockResolvedValue(makeRow({ status: 'COMPLETED' }));
    deps.prisma.dailyDiagnosis.update.mockResolvedValue(makeRow({ status: 'COMPLETED', healthScore: 88 }));
    deps.openclaw.chat.mockResolvedValue({
      success: true,
      content: JSON.stringify({ healthScore: 88, summary: '重算后更乐观', highlights: [], risks: [], recommendations: [] }),
    });
    const service = makeService(deps);

    const result = await service.regenerate(ADMIN);

    expect(deps.openclaw.chat).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('COMPLETED');
    expect(result.healthScore).toBe(88);
  });

  it('rejects regenerate when no snapshot exists', async () => {
    const deps = makeDeps();
    deps.prisma.dailyDiagnosis.findUnique.mockResolvedValue(null);
    const service = makeService(deps);

    await expect(service.regenerate(ADMIN)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('DailyDiagnosisController HTTP contract', () => {
  it('GET /daily-diagnosis/today delegates to service with companyId query', async () => {
    const service = { getToday: jest.fn().mockResolvedValue({ status: 'COMPLETED', summary: 'ok' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [DailyDiagnosisController],
      providers: [{ provide: DailyDiagnosisService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = moduleRef.createNestApplication();
    app.use((req: any, _res: any, next: () => void) => {
      req.user = ADMIN;
      next();
    });
    await app.init();

    await request(app.getHttpServer())
      .get('/daily-diagnosis/today')
      .query({ companyId: 'comp-1' })
      .expect(200)
      .expect({ status: 'COMPLETED', summary: 'ok' });
    expect(service.getToday).toHaveBeenCalledWith(ADMIN, 'comp-1');
    await app.close();
  });
});
