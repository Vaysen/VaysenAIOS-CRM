import path from 'path';

const mockResize = jest.fn(() => ({ isEmpty: () => false }));
const mockCreateFromPath = jest.fn(() => ({ isEmpty: () => false, resize: mockResize }));
const mockTrayConstructor = jest.fn(() => ({
  setToolTip: jest.fn(),
  setContextMenu: jest.fn(),
  on: jest.fn(),
  destroy: jest.fn(),
}));

jest.mock('electron', () => ({
  app: { isPackaged: true, quit: jest.fn() },
  Tray: mockTrayConstructor,
  Menu: { buildFromTemplate: jest.fn(() => ({})) },
  nativeImage: { createFromPath: mockCreateFromPath, createEmpty: jest.fn(() => ({ isEmpty: () => true })) },
}));

import { TrayManager } from '../src/main/tray';

describe('TrayManager brand resource', () => {
  const resourcesPath = path.join('C:', 'Program Files', 'Vaysen AI CRM', 'resources');

  beforeAll(() => {
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath });
  });

  it('loads the packaged company icon and resizes it for the Windows tray', () => {
    const windowManager = { getMainWindow: jest.fn(() => null) } as any;
    const manager = new TrayManager(windowManager);

    expect(mockCreateFromPath).toHaveBeenCalledWith(path.join(resourcesPath, 'brand', 'icon.ico'));
    expect(mockResize).toHaveBeenCalledWith({ width: 16, height: 16 });
    expect(mockTrayConstructor).toHaveBeenCalled();
    manager.destroy();
  });
});
