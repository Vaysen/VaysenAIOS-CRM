const updaterMock = {
  setFeedURL: jest.fn(),
  checkForUpdates: jest.fn(() => Promise.resolve()),
  downloadUpdate: jest.fn(() => Promise.resolve()),
  quitAndInstall: jest.fn(),
  on: jest.fn(),
  autoDownload: true,
  autoInstallOnAppQuit: false,
};

const mockIpcHandle = jest.fn();
jest.mock('electron', () => ({
  ipcMain: { handle: mockIpcHandle },
  BrowserWindow: jest.fn(),
}));

jest.mock('electron-updater', () => ({ autoUpdater: updaterMock }));

const getValidatedUpdateFeedUrl = jest.fn();
const isAutoUpdateEnabled = jest.fn();
jest.mock('../src/shared/runtime-config', () => {
  const actual = jest.requireActual('../src/shared/runtime-config');
  return {
    ...actual,
    getValidatedUpdateFeedUrl,
    isAutoUpdateEnabled,
  };
});

import { ipcMain } from 'electron';
import { AutoUpdater } from '../src/main/auto-updater';
import { IPC_CHANNELS } from '../src/shared/ipc-channels';
import { RuntimeConfigError } from '../src/shared/runtime-config';

function registeredHandlers(): Record<string, (...args: any[]) => any> {
  return Object.fromEntries(
    (ipcMain.handle as jest.Mock).mock.calls.map(([channel, handler]) => [channel, handler]),
  );
}

describe('AutoUpdater fail-closed lifecycle', () => {
  beforeEach(() => {
    jest.useRealTimers();
    updaterMock.setFeedURL.mockClear();
    updaterMock.checkForUpdates.mockClear();
    updaterMock.downloadUpdate.mockClear();
    updaterMock.quitAndInstall.mockClear();
    updaterMock.on.mockClear();
    (ipcMain.handle as jest.Mock).mockClear();
    getValidatedUpdateFeedUrl.mockReset();
    isAutoUpdateEnabled.mockReset();
    isAutoUpdateEnabled.mockReturnValue(true);
  });

  test('LAN mode disables updater without treating API configuration as invalid', async () => {
    isAutoUpdateEnabled.mockReturnValue(false);
    const webContents = { send: jest.fn() };
    const updater = new AutoUpdater();
    updater.setMainWindow({ isDestroyed: () => false, webContents } as any);

    expect(updater.initialize()).toBe(false);
    expect(getValidatedUpdateFeedUrl).not.toHaveBeenCalled();
    expect(updaterMock.setFeedURL).not.toHaveBeenCalled();
    expect(webContents.send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.APP_CONFIG_INVALID,
      expect.anything(),
    );

    const handlers = registeredHandlers();
    await expect(handlers[IPC_CHANNELS.APP_CHECK_UPDATE]()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('人工覆盖安装'),
    });
  });

  test('invalid feed keeps IPC available but blocks every update action', async () => {
    getValidatedUpdateFeedUrl.mockImplementation(() => {
      throw new RuntimeConfigError(
        'updateFeedUrl',
        'http://updates.example.com/desktop',
        'HTTP 更新源被拒绝',
      );
    });
    const webContents = { send: jest.fn() };
    const updater = new AutoUpdater();
    updater.setMainWindow({ isDestroyed: () => false, webContents } as any);

    expect(updater.initialize()).toBe(false);
    const handlers = registeredHandlers();
    expect(Object.keys(handlers)).toEqual(expect.arrayContaining([
      IPC_CHANNELS.APP_CHECK_UPDATE,
      IPC_CHANNELS.APP_DOWNLOAD_UPDATE,
      IPC_CHANNELS.APP_INSTALL_UPDATE,
    ]));
    await expect(handlers[IPC_CHANNELS.APP_CHECK_UPDATE]()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('HTTP 更新源被拒绝'),
    });
    expect(() => handlers[IPC_CHANNELS.APP_INSTALL_UPDATE]()).toThrow(/HTTP 更新源被拒绝/);
    expect(updaterMock.checkForUpdates).not.toHaveBeenCalled();
    expect(webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.APP_CONFIG_INVALID,
      expect.objectContaining({ field: 'updateFeedUrl' }),
    );
  });

  test('valid feed initializes updater and launch check is scheduled', async () => {
    jest.useFakeTimers();
    getValidatedUpdateFeedUrl.mockReturnValue('https://updates.example.com/desktop');
    const updater = new AutoUpdater();

    expect(updater.initialize()).toBe(true);
    expect(updaterMock.setFeedURL).toHaveBeenCalledWith('https://updates.example.com/desktop');
    expect(updaterMock.autoDownload).toBe(false);
    expect(updaterMock.autoInstallOnAppQuit).toBe(true);

    const handlers = registeredHandlers();
    await expect(handlers[IPC_CHANNELS.APP_CHECK_UPDATE]()).resolves.toEqual({ success: true });
    expect(updaterMock.checkForUpdates).toHaveBeenCalledTimes(1);

    updater.checkOnLaunch();
    jest.advanceTimersByTime(30000);
    await Promise.resolve();
    expect(updaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});
