import { describe, expect, it } from 'vitest';
import { buildSalesAutomationItems } from './sidebar';

describe('sales automation sidebar domain', () => {
  it.each(['viewer', 'sales_user', undefined])(
    'hides all management entries from %s',
    (role) => {
      expect(buildSalesAutomationItems(role)).toEqual([]);
    },
  );

  it.each(['sales_manager', 'company_admin', 'super_admin'])(
    'nests both enabled management entries for %s',
    (role) => {
      expect(buildSalesAutomationItems(role).map((item) => item.href)).toEqual([
        '/sales-sequences',
        '/customer-facts',
      ]);
    },
  );

  it('honors the parent and individual feature switches independently', () => {
    expect(buildSalesAutomationItems('company_admin', {
      salesAutomation: false,
      salesSequencesManagement: true,
      customerFactsReview: true,
    })).toEqual([]);
    expect(buildSalesAutomationItems('company_admin', {
      salesAutomation: true,
      salesSequencesManagement: false,
      customerFactsReview: true,
    }).map((item) => item.href)).toEqual(['/customer-facts']);
    expect(buildSalesAutomationItems('company_admin', {
      salesAutomation: true,
      salesSequencesManagement: true,
      customerFactsReview: false,
    }).map((item) => item.href)).toEqual(['/sales-sequences']);
  });
});
