import { LeadsService } from './leads.service';

describe('LeadsService WhatsApp identity search', () => {
  it('searches legacy phone fields and the verified WhatsApp ContactPoint anchor', () => {
    const service = new LeadsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const currentUser = {
      id: 'admin-1',
      companies: [{
        id: '11111111-1111-4111-8111-111111111111',
        role: 'company_admin',
      }],
    };

    const where = (service as any).buildWhereClause(currentUser, {
      search: '8615306009641',
    });

    expect(where.OR).toEqual(expect.arrayContaining([
      { contactPhone: { contains: '8615306009641', mode: 'insensitive' } },
      { whatsapp: { contains: '8615306009641', mode: 'insensitive' } },
      {
        contactPoints: {
          some: {
            type: 'whatsapp',
            isVerified: true,
            OR: [
              { normalizedValue: { contains: '8615306009641', mode: 'insensitive' } },
              { originalValue: { contains: '8615306009641', mode: 'insensitive' } },
            ],
          },
        },
      },
    ]));
  });
});
