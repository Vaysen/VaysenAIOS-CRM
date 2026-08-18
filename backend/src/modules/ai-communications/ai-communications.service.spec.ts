import { AiCommunicationsService } from './ai-communications.service';

describe('AiCommunicationsService translation cache', () => {
  it('scopes a draft translation cache by company and target language', async () => {
    const companyId = '11111111-1111-4111-8111-111111111111';
    const artifacts: any[] = [{
      companyId,
      artifactType: 'translation',
      inputContent: '你好',
      outputContent: '你好',
      extraData: { targetLanguage: 'zh' },
      createdAt: new Date(),
    }];
    const prisma: any = {
      aiArtifact: {
        findFirst: jest.fn(async ({ where }: any) => artifacts.find((item) => (
          item.companyId === where.companyId
          && item.inputContent === where.inputContent
          && item.extraData.targetLanguage === where.extraData.equals
        )) || null),
        create: jest.fn(async ({ data }: any) => {
          const created = { id: 'artifact-en', createdAt: new Date(), ...data };
          artifacts.push(created);
          return created;
        }),
      },
    };
    const ai: any = {
      chat: jest.fn().mockResolvedValue({
        success: true,
        reason: 'success',
        content: 'Hello',
        model: 'glm-4.5-air',
      }),
      getModel: jest.fn().mockReturnValue('glm-4.5-air'),
    };
    const service = new AiCommunicationsService(prisma, ai);
    const user = {
      activeCompanyId: companyId,
      activeCompany: { id: companyId, name: companyId, role: 'sales_user' },
      companies: [{ id: companyId, name: companyId, role: 'sales_user' }],
    };

    const first = await service.translateDraft('你好', user, 'en');
    const second = await service.translateDraft('你好', user, 'en');

    expect(first).toEqual(expect.objectContaining({ draft: 'Hello', language: 'en' }));
    expect(second).toEqual(expect.objectContaining({ draft: 'Hello', cached: true }));
    expect(ai.chat).toHaveBeenCalledTimes(1);
    expect(prisma.aiArtifact.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId,
        extraData: { path: ['targetLanguage'], equals: 'en' },
      }),
    }));
    expect(prisma.aiArtifact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ extraData: { targetLanguage: 'en' } }),
    }));
  });
});
