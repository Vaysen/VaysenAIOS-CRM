/**
 * R111 批次D：exchange-rates 单测。
 * 覆盖：fallback 链（jsDelivr→pages.dev→frankfurter→静态兜底）、CNY base 组装、
 * 内存缓存 TTL 内不重复抓取。
 */
import { ExchangeRatesService } from './exchange-rates.service';

describe('ExchangeRatesService (R111 批次D)', () => {
  let service: ExchangeRatesService;

  beforeEach(() => {
    service = new ExchangeRatesService();
    service.clearCache();
  });

  it('serves the static fallback when every provider fails (source=static-fallback)', async () => {
    (service as any).http.get = jest.fn().mockRejectedValue(new Error('network down'));
    const payload = await service.getLatest();

    expect(payload.base).toBe('CNY');
    expect(payload.source).toBe('static-fallback');
    expect(payload.rates.USD).toBeGreaterThan(0);
    expect(payload.rates.EUR).toBeGreaterThan(0);
    expect(payload.rates.GBP).toBeGreaterThan(0);
    expect(payload.rates.JPY).toBeGreaterThan(0);
    // 静态兜底 USD/CNY = quotes 模块 protectionFxRateCnyPerUsd
    expect(payload.cross['USD/CNY']).toBe(payload.rates.USD);
    expect(payload.cross['USD/EUR']).toBeGreaterThan(0);
    expect(payload.updatedAt).toBeTruthy();
  });

  it('uses jsDelivr (fawazahmed0) data when it succeeds', async () => {
    (service as any).http.get = jest.fn().mockResolvedValue({
      data: { date: '2026-08-18', usd: { cny: 7.1245, eur: 0.9096, gbp: 0.7834, jpy: 149.2 } },
    });
    const payload = await service.getLatest();

    expect(payload.source).toBe('fawazahmed0');
    expect(payload.rates.USD).toBeCloseTo(7.1245, 3);
    expect(payload.rates.EUR).toBeCloseTo(7.1245 / 0.9096, 3);
    expect(payload.cross['USD/EUR']).toBeCloseTo(0.9096, 3);
    expect(payload.cross['USD/CNY']).toBeCloseTo(7.1245, 3);
  });

  it('falls back to frankfurter when both fawazahmed0 hosts fail', async () => {
    const get = jest.fn()
      .mockRejectedValueOnce(new Error('jsdelivr down'))
      .mockRejectedValueOnce(new Error('pages.dev down'))
      .mockResolvedValueOnce({ data: { base: 'USD', rates: { CNY: 7.1245, EUR: 0.9096, GBP: 0.7834, JPY: 149.2 } } });
    (service as any).http.get = get;

    const payload = await service.getLatest();
    expect(payload.source).toBe('frankfurter');
    expect(payload.rates.USD).toBeCloseTo(7.1245, 3);
    expect(payload.cross['USD/EUR']).toBeCloseTo(0.9096, 3);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('rejects unusable provider data and continues the fallback chain', async () => {
    const get = jest.fn()
      .mockResolvedValueOnce({ data: { usd: { cny: 'bad', eur: 0.9, gbp: 0.78, jpy: 149 } } }) // jsDelivr 数据不可用 → 跳过
      .mockRejectedValueOnce(new Error('pages.dev down'))
      .mockResolvedValueOnce({ data: { base: 'USD', rates: { CNY: 7.1, EUR: 0.91, GBP: 0.78, JPY: 149 } } });
    (service as any).http.get = get;

    const payload = await service.getLatest();
    expect(payload.source).toBe('frankfurter');
    expect(payload.rates.USD).toBeCloseTo(7.1, 3);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('caches within TTL and does not refetch', async () => {
    (service as any).http.get = jest.fn().mockResolvedValue({
      data: { usd: { cny: 7.1, eur: 0.9, gbp: 0.78, jpy: 149 } },
    });
    const first = await service.getLatest();
    const second = await service.getLatest();

    expect(second).toBe(first);
    expect((service as any).http.get).toHaveBeenCalledTimes(1);
  });
});
