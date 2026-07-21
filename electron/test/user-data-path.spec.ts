import path from 'path';
import {
  configureStableUserDataPath,
  STABLE_USER_DATA_DIRECTORY,
} from '../src/main/user-data-path';

describe('stable Electron userData path', () => {
  test('keeps the legacy package-name directory across product-name changes', () => {
    const setPath = jest.fn();
    const app = {
      getPath: jest.fn(() => path.join('C:', 'Users', 'tester', 'AppData', 'Roaming')),
      setPath,
    };

    const result = configureStableUserDataPath(app);

    expect(result).toBe(
      path.join('C:', 'Users', 'tester', 'AppData', 'Roaming', STABLE_USER_DATA_DIRECTORY),
    );
    expect(setPath).toHaveBeenCalledWith('userData', result);
  });

  test('uses the immutable historical directory name', () => {
    expect(STABLE_USER_DATA_DIRECTORY).toBe('vaysen-crm-desktop');
  });

  test('honors an explicit Electron user-data-dir for isolated acceptance runs', () => {
    const setPath = jest.fn();
    const requested = path.join('C:', 'temp', 'vaysen-crm-acceptance');
    const app = {
      getPath: jest.fn(() => 'unused'),
      setPath,
      commandLine: { getSwitchValue: jest.fn(() => requested) },
    };

    const result = configureStableUserDataPath(app);

    expect(result).toBe(path.resolve(requested));
    expect(setPath).toHaveBeenCalledWith('userData', path.resolve(requested));
    expect(app.getPath).not.toHaveBeenCalled();
  });
});
