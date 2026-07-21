import path from 'path';

export const STABLE_USER_DATA_DIRECTORY = 'vaysen-crm-desktop';

interface AppPathAdapter {
  getPath(name: 'appData'): string;
  setPath(name: 'userData', value: string): void;
  commandLine?: {
    getSwitchValue(name: string): string;
  };
}

/**
 * 产品显示名可以变化，但 Electron userData 路径必须保持稳定。
 * 旧版 1.0.0 使用 package name `vaysen-crm-desktop`，其中保存登录令牌、
 * electron-store 配置和会话数据；升级时继续复用该目录，避免静默丢数据。
 */
export function configureStableUserDataPath(app: AppPathAdapter): string {
  const explicitPath = app.commandLine?.getSwitchValue('user-data-dir')?.trim();
  if (explicitPath) {
    const resolvedExplicitPath = path.resolve(explicitPath);
    app.setPath('userData', resolvedExplicitPath);
    return resolvedExplicitPath;
  }
  const stablePath = path.join(app.getPath('appData'), STABLE_USER_DATA_DIRECTORY);
  app.setPath('userData', stablePath);
  return stablePath;
}
