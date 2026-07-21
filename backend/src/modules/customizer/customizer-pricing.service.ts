import { Injectable, Logger } from '@nestjs/common';

export interface PricingInput {
  basePrice: number;
  moq: number;
  quantity: number;
  materialSurcharge: number;
  logoEffectSurcharge: number;
  logoEffectColors?: number;
}

export interface PricingResult {
  basePrice: number;
  materialSurcharge: number;
  logoEffectSurcharge: number;
  quantityDiscount: number;
  quantityDiscountRate: number;
  unitPrice: number;
  totalPrice: number;
  currency: string;
}

/**
 * Pricing engine for the customizer module.
 *
 * Formula:
 *   unitPrice = basePrice + materialSurcharge + logoEffectSurcharge - quantityDiscount
 *   totalPrice = unitPrice * quantity
 *
 * Quantity discount:
 *   0% at MOQ, up to 15% at 10x MOQ (linear).
 *   rate = min((ratio - 1) * 0.015, 0.15)
 *   where ratio = quantity / moq
 */
@Injectable()
export class CustomizerPricingService {
  private readonly logger = new Logger(CustomizerPricingService.name);

  private static readonly MAX_DISCOUNT_RATE = 0.15;
  private static readonly DISCOUNT_SLOPE = 0.015;

  /**
   * Calculate the quantity discount rate based on the ratio of quantity to MOQ.
   * Returns a value between 0 and 0.15 (15%).
   */
  calculateQuantityDiscountRate(quantity: number, moq: number): number {
    if (moq <= 0 || quantity <= 0) return 0;
    const ratio = quantity / moq;
    if (ratio <= 1) return 0;
    const rate = (ratio - 1) * CustomizerPricingService.DISCOUNT_SLOPE;
    return Math.min(rate, CustomizerPricingService.MAX_DISCOUNT_RATE);
  }

  /**
   * Calculate the full pricing breakdown for a customizer configuration.
   */
  calculate(input: PricingInput, currency: string = 'USD'): PricingResult {
    const { basePrice, moq, quantity, materialSurcharge, logoEffectSurcharge } = input;

    const discountRate = this.calculateQuantityDiscountRate(quantity, moq);
    const subtotalBeforeDiscount = basePrice + materialSurcharge + logoEffectSurcharge;
    const quantityDiscount = +(subtotalBeforeDiscount * discountRate).toFixed(4);
    const unitPrice = +(subtotalBeforeDiscount - quantityDiscount).toFixed(4);
    const totalPrice = +(unitPrice * quantity).toFixed(2);

    return {
      basePrice: +basePrice.toFixed(4),
      materialSurcharge: +materialSurcharge.toFixed(4),
      logoEffectSurcharge: +logoEffectSurcharge.toFixed(4),
      quantityDiscount,
      quantityDiscountRate: +discountRate.toFixed(4),
      unitPrice,
      totalPrice,
      currency,
    };
  }
}
