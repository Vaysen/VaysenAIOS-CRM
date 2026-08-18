/**
 * exchange-rates.service.ts
 *
 * R111 批次D：汇率模块（CNY base）。
 * - GET /exchange-rates/latest：返回 { base: "CNY", rates: { USD, EUR, GBP, JPY },
 *   cross: { "USD/EUR": ..., "USD/CNY": ... }, updatedAt, source }。
 * - 内存缓存（模块级 Map + updatedAt），TTL 默认 4 小时（EXCHANGE_RATES_FETCH_INTERVAL_MS）。
 * - 抓取顺序（第一个成功即用，失败依次 fallback）：
 *   a. https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json
 *   b. https://{today}.currency-api.pages.dev/v1/currencies/usd.json（同结构）
 *   c. https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY,EUR,GBP,JPY
 *   d. 静态 fallback：quotes 模块 protectionFxRateCnyPerUsd + 近似交叉，source='static-fallback'
 * - 超时 10s；独立 axios 实例 + proxy:false；外网失败不阻塞（try/catch 全链）。
 * - 环境变量：EXCHANGE_RATES_ENABLED（默认 true）、EXCHANGE_RATES_FETCH_INTERVAL_MS（默认 14400000）。
 */

import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import usdPriceCatalog from '../products/data/usd-price-catalog.json';

const DEFAULT_TTL_MS = 14_400_000; // 4 小时
const FETCH_TIMEOUT_MS = 10_000;

export interface ExchangeRatesPayload {
  base: 'CNY';
  rates: { USD: number; EUR: number; GBP: number; JPY: number };
  cross: Record<string, number>;
  updatedAt: string;
  source: 'fawazahmed0' | 'frankfurter' | 'static-fallback';
}

type UsdRates = { usdCny: number; usdEur: number; usdGbp: number; usdJpy: number };

@Injectable()
export class ExchangeRatesService {
  private readonly logger = new Logger(ExchangeRatesService.name);
  /** 模块级内存缓存：{ expiresAt, payload } */
  private cache: { expiresAt: number; payload: ExchangeRatesPayload } | null = null;
  /** 防并发击穿：抓取进行中时复用同一 Promise */
  private inFlight: Promise<ExchangeRatesPayload> | null = null;
  /** 独立 axios 实例（proxy:false 直连，不影响其他模块） */
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      timeout: FETCH_TIMEOUT_MS,
      proxy: false,
      headers: { accept: 'application/json' },
    });
  }

  private isEnabled(): boolean {
    return process.env.EXCHANGE_RATES_ENABLED !== 'false';
  }

  private ttlMs(): number {
    const raw = Number(process.env.EXCHANGE_RATES_FETCH_INTERVAL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
  }

  /** 最新汇率：缓存命中直接返回；否则按 fallback 链抓取。 */
  async getLatest(): Promise<ExchangeRatesPayload> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.payload;
    }
    if (this.inFlight) return this.inFlight;

    const pending = this.fetchFresh();
    this.inFlight = pending;
    try {
      const payload = await pending;
      this.cache = { expiresAt: Date.now() + this.ttlMs(), payload };
      return payload;
    } finally {
      if (this.inFlight === pending) this.inFlight = null;
    }
  }

  /** 测试辅助：清空缓存与进行中抓取。 */
  clearCache() {
    this.cache = null;
    this.inFlight = null;
  }

  private async fetchFresh(): Promise<ExchangeRatesPayload> {
    if (!this.isEnabled()) {
      this.logger.log('Exchange rates disabled, using static fallback');
      return this.buildStaticPayload();
    }
    const providers: Array<{ name: ExchangeRatesPayload['source']; fetch: () => Promise<UsdRates> }> = [
      { name: 'fawazahmed0', fetch: () => this.fetchFawazahmed0('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json') },
      { name: 'fawazahmed0', fetch: () => this.fetchFawazahmed0(this.pagesDevUrl()) },
      { name: 'frankfurter', fetch: () => this.fetchFrankfurter() },
    ];
    for (const provider of providers) {
      try {
        const usd = await provider.fetch();
        if (!this.isUsdRatesUsable(usd)) continue;
        return this.buildPayload(usd, provider.name);
      } catch (error) {
        this.logger.warn(`Exchange rate provider failed (${provider.name}): ${this.errorText(error)}`);
      }
    }
    this.logger.warn('All exchange rate providers failed, using static fallback');
    return this.buildStaticPayload();
  }

  private isUsdRatesUsable(usd: UsdRates): boolean {
    const values = [usd.usdCny, usd.usdEur, usd.usdGbp, usd.usdJpy];
    return values.every((v) => Number.isFinite(v) && v > 0);
  }

  /** fawazahmed0 结构：{ date, usd: { cny, eur, gbp, jpy, ... } }（每 1 USD 对应各币种数量） */
  private async fetchFawazahmed0(url: string): Promise<UsdRates> {
    const { data } = await this.http.get<Record<string, any>>(url);
    const usd = data?.usd;
    if (!usd || typeof usd !== 'object') throw new Error('unexpected_fawazahmed0_shape');
    return {
      usdCny: Number(usd.cny),
      usdEur: Number(usd.eur),
      usdGbp: Number(usd.gbp),
      usdJpy: Number(usd.jpy),
    };
  }

  /** pages.dev 版本化 URL：https://{YYYY-MM-DD}.currency-api.pages.dev/v1/currencies/usd.json */
  private pagesDevUrl(): string {
    const today = new Date().toISOString().slice(0, 10);
    return `https://${today}.currency-api.pages.dev/v1/currencies/usd.json`;
  }

  /** frankfurter：{ base: "USD", rates: { CNY, EUR, GBP, JPY } }（每 1 USD 对应各币种数量） */
  private async fetchFrankfurter(): Promise<UsdRates> {
    const { data } = await this.http.get<{ base?: string; rates?: Record<string, number> }>(
      'https://api.frankfurter.dev/v1/latest',
      { params: { base: 'USD', symbols: 'CNY,EUR,GBP,JPY' } },
    );
    const rates = data?.rates;
    if (!rates || typeof rates !== 'object') throw new Error('unexpected_frankfurter_shape');
    return {
      usdCny: Number(rates.CNY),
      usdEur: Number(rates.EUR),
      usdGbp: Number(rates.GBP),
      usdJpy: Number(rates.JPY),
    };
  }

  /** 静态 fallback：quotes 模块 protectionFxRateCnyPerUsd + 近似交叉。 */
  private buildStaticPayload(): ExchangeRatesPayload {
    const usdCny = Number(usdPriceCatalog.pricingPolicy.protectionFxRateCnyPerUsd) || 7.15;
    // 近似交叉（CNY 基准）：EUR 7.85、GBP 9.12、JPY 0.048
    const eurCny = 7.85;
    const gbpCny = 9.12;
    const jpyCny = 0.048;
    const usd: UsdRates = {
      usdCny,
      usdEur: usdCny / eurCny,
      usdGbp: usdCny / gbpCny,
      usdJpy: usdCny / jpyCny,
    };
    return this.buildPayload(usd, 'static-fallback');
  }

  /** 统一组装：CNY base 的 rates + 交叉汇率 cross。 */
  private buildPayload(usd: UsdRates, source: ExchangeRatesPayload['source']): ExchangeRatesPayload {
    const rates = {
      USD: this.round(usd.usdCny),
      EUR: this.round(usd.usdCny / usd.usdEur),
      GBP: this.round(usd.usdCny / usd.usdGbp),
      JPY: this.round(usd.usdCny / usd.usdJpy),
    };
    const cross: Record<string, number> = {
      'USD/CNY': this.round(usd.usdCny),
      'USD/EUR': this.round(usd.usdEur),
      'USD/GBP': this.round(usd.usdGbp),
      'USD/JPY': this.round(usd.usdJpy),
      'EUR/CNY': this.round(rates.EUR),
      'EUR/USD': this.round(1 / usd.usdEur),
      'EUR/GBP': this.round(usd.usdEur / usd.usdGbp),
      'EUR/JPY': this.round(usd.usdEur / usd.usdJpy),
      'GBP/CNY': this.round(rates.GBP),
      'GBP/USD': this.round(1 / usd.usdGbp),
      'GBP/EUR': this.round(usd.usdGbp / usd.usdEur),
      'GBP/JPY': this.round(usd.usdGbp / usd.usdJpy),
      'JPY/CNY': this.round(rates.JPY),
      'JPY/USD': this.round(1 / usd.usdJpy),
      'JPY/EUR': this.round(usd.usdJpy / usd.usdEur),
      'JPY/GBP': this.round(usd.usdJpy / usd.usdGbp),
    };
    return {
      base: 'CNY',
      rates,
      cross,
      updatedAt: new Date().toISOString(),
      source,
    };
  }

  /** 保留 4 位小数（交叉汇率精度足够，避免浮点噪声）。 */
  private round(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * 10_000) / 10_000;
  }

  private errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
