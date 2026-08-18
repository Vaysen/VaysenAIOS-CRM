import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { UpdateQuoteDto } from './dto/update-quote.dto';
import { calculateQuoteTotals } from './quotes.service';

describe('Quote packaging money contract', () => {
  it('uses subtotal, post-discount tax, and both packaging fees exactly once', () => {
    expect(calculateQuoteTotals([100, 50], 10, 7.25, '2.50', '1.25'))
      .toEqual({
        subtotal: 150,
        taxAmount: 10.15,
        totalAmount: 153.9,
        sampleFee: 2.5,
        moldFee: 1.25,
      });
  });

  it('treats legacy null and omitted fees as zero', () => {
    expect(calculateQuoteTotals([100], 0, 0, null, undefined).totalAmount).toBe(100);
  });

  it('rejects fee values outside non-negative two-decimal database bounds', async () => {
    const createCases = [
      { sampleFee: -0.01 },
      { moldFee: 1.234 },
      { moldFee: 100_000_000 },
    ];
    for (const input of createCases) {
      const errors = await validate(plainToInstance(CreateQuoteDto, {
        lineItems: [{ productName: 'Box', quantity: 1, unitPrice: 1 }],
        ...input,
      }));
      expect(errors.some((error) => error.property === 'sampleFee' || error.property === 'moldFee'))
        .toBe(true);
    }

    const updateErrors = await validate(
      plainToInstance(UpdateQuoteDto, { moldFee: 12.345 }),
    );
    expect(updateErrors.some((error) => error.property === 'moldFee')).toBe(true);
  });
});
