import { LeadsService } from './leads.service';

describe('external lead archive policy', () => {
  const originalEnabled = process.env.EXTERNAL_LEAD_ARCHIVE_ENABLED;
  const originalPath = process.env.EXTERNAL_LEAD_ARCHIVE_PATH;
  const currentUser = {
    id: 'admin-1',
    email: 'admin@example.com',
    companies: [{ id: 'company-1', name: 'Example Trading Company', role: 'company_admin' }],
  };

  const createService = () => new LeadsService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.EXTERNAL_LEAD_ARCHIVE_ENABLED;
    else process.env.EXTERNAL_LEAD_ARCHIVE_ENABLED = originalEnabled;
    if (originalPath === undefined) delete process.env.EXTERNAL_LEAD_ARCHIVE_PATH;
    else process.env.EXTERNAL_LEAD_ARCHIVE_PATH = originalPath;
  });

  it('is fail-closed by default and never probes a historical workstation path', async () => {
    delete process.env.EXTERNAL_LEAD_ARCHIVE_ENABLED;
    delete process.env.EXTERNAL_LEAD_ARCHIVE_PATH;

    await expect(createService().syncExternalMarkdownLeads(currentUser))
      .rejects.toThrow('External lead archive import is disabled');
  });

  it('requires an explicit mounted path when enabled', async () => {
    process.env.EXTERNAL_LEAD_ARCHIVE_ENABLED = 'true';
    delete process.env.EXTERNAL_LEAD_ARCHIVE_PATH;

    await expect(createService().syncExternalMarkdownLeads(currentUser))
      .rejects.toThrow('EXTERNAL_LEAD_ARCHIVE_PATH is not configured');
  });
});
