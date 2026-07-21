import * as path from 'path';
import { getMaterialsUploadDir } from './materials.service';

describe('materials upload persistence path', () => {
  const original = process.env.UPLOADS_DIR;

  afterEach(() => {
    if (original === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = original;
  });

  it('uses the runtime working directory so dist and src persist to /app/uploads', () => {
    delete process.env.UPLOADS_DIR;
    expect(getMaterialsUploadDir()).toBe(path.resolve(process.cwd(), 'uploads'));
  });

  it('supports an explicit absolute persistent-volume mount', () => {
    process.env.UPLOADS_DIR = path.join(process.cwd(), 'persistent-uploads');
    expect(getMaterialsUploadDir()).toBe(path.resolve(process.env.UPLOADS_DIR));
  });
});
