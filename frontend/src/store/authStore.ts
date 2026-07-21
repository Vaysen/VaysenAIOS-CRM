import { create } from 'zustand';
import api from '@/lib/api';

interface Company {
  id: string;
  name: string;
  slug: string;
  role: string;
  isDefault: boolean;
}

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  avatar?: string;
  companies: Company[];
}

interface AuthState {
  user: User | null;
  token: string | null;
  refreshToken: string | null;
  activeCompanyId: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  register: (
    email: string,
    password: string,
    firstName: string,
    lastName: string,
    companyName?: string,
  ) => Promise<void>;
  fetchProfile: () => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
  setAuth: (user: User, token: string, refreshToken: string) => void;
  setActiveCompany: (companyId: string) => void;
}

function getForcedCompanySlug(): string | null {
  return process.env.NEXT_PUBLIC_FORCE_COMPANY_SLUG || null;
}

/** Sync auth token to cookie so Next.js middleware can read it (SSR) */
function setAuthCookie(token: string) {
  if (typeof document !== 'undefined') {
    document.cookie = `token=${token}; path=/; max-age=86400; SameSite=Lax`;
  }
}

function clearAuthCookie() {
  if (typeof document !== 'undefined') {
    document.cookie = 'token=; path=/; max-age=0';
  }
}

function resolveActiveCompanyId(user: User, preferredCompanyId?: string | null): string | null {
  const forcedSlug = getForcedCompanySlug();
  const forcedCompany = forcedSlug
    ? user.companies?.find((company) => company.slug === forcedSlug)
    : null;
  if (forcedCompany) return forcedCompany.id;

  const canUsePreferred = preferredCompanyId
    ? user.companies?.some((company) => company.id === preferredCompanyId)
    : false;
  if (canUsePreferred && preferredCompanyId) return preferredCompanyId;

  return user.companies?.find((company) => company.isDefault)?.id || user.companies?.[0]?.id || null;
}

function withActiveCompanyFirst(user: User, activeCompanyId: string | null): User {
  if (!activeCompanyId) return user;
  const index = user.companies?.findIndex((company) => company.id === activeCompanyId) ?? -1;
  if (index <= 0) return user;
  const companies = [
    user.companies[index],
    ...user.companies.filter((_, itemIndex) => itemIndex !== index),
  ];
  return { ...user, companies };
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: typeof window !== 'undefined' ? localStorage.getItem('access_token') : null,
  refreshToken:
    typeof window !== 'undefined' ? localStorage.getItem('refresh_token') : null,
  activeCompanyId:
    typeof window !== 'undefined' ? localStorage.getItem('active_company_id') : null,
  isAuthenticated: false,
  isLoading: false,
  error: null,

  setAuth: (user, token, refreshToken) => {
    localStorage.setItem('access_token', token);
    localStorage.setItem('refresh_token', refreshToken);
    setAuthCookie(token);
    const activeCompanyId = resolveActiveCompanyId(user, localStorage.getItem('active_company_id'));
    if (activeCompanyId) {
      localStorage.setItem('active_company_id', activeCompanyId);
    }
    // Electron 环境：同步 token 到 safeStorage（供主进程 pushToBackend 使用）
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.auth.setToken(token, refreshToken).catch((error) => { console.error('[Frontend] background operation failed:', error); });
      if (activeCompanyId) {
        window.electronAPI.auth.setCompany(activeCompanyId).catch((error) => { console.error('[Frontend] background operation failed:', error); });
      }
    }
    set({ user: withActiveCompanyFirst(user, activeCompanyId), token, refreshToken, activeCompanyId, isAuthenticated: true, error: null });
  },

  login: async (username, password) => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.post('/auth/login', { email: username, password });
      const { accessToken, refreshToken, user } = res.data;
      localStorage.setItem('access_token', accessToken);
      localStorage.setItem('refresh_token', refreshToken);
      setAuthCookie(accessToken);
      const activeCompanyId = resolveActiveCompanyId(user, localStorage.getItem('active_company_id'));
      if (activeCompanyId) {
        localStorage.setItem('active_company_id', activeCompanyId);
      }
      // Electron 环境：同步 token 到 safeStorage
      if (typeof window !== 'undefined' && window.electronAPI) {
        window.electronAPI.auth.setToken(accessToken, refreshToken).catch((error) => { console.error('[Frontend] background operation failed:', error); });
        if (activeCompanyId) {
          window.electronAPI.auth.setCompany(activeCompanyId).catch((error) => { console.error('[Frontend] background operation failed:', error); });
        }
      }
      set({
        user: withActiveCompanyFirst(user, activeCompanyId),
        token: accessToken,
        refreshToken,
        activeCompanyId,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
    } catch (err: any) {
      const message =
        err.response?.data?.message || 'Login failed. Please check your email and password.';
      set({ isLoading: false, error: message });
      throw new Error(message);
    }
  },

  register: async (email, password, firstName, lastName, companyName) => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.post('/auth/register', {
        email,
        password,
        firstName,
        lastName,
        companyName,
      });
      const { accessToken, refreshToken, user } = res.data;
      localStorage.setItem('access_token', accessToken);
      localStorage.setItem('refresh_token', refreshToken);
      setAuthCookie(accessToken);
      const activeCompanyId = resolveActiveCompanyId(user);
      if (activeCompanyId) {
        localStorage.setItem('active_company_id', activeCompanyId);
      }
      set({
        user: withActiveCompanyFirst(user, activeCompanyId),
        token: accessToken,
        refreshToken,
        activeCompanyId,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      });
    } catch (err: any) {
      const status = err.response?.status || 'NETWORK';
      const data = err.response?.data;

      let message: string;
      if (Array.isArray(data?.message)) {
        message = data.message.join('; ');
      } else if (typeof data?.message === 'string') {
        message = data.message;
      } else if (typeof data?.error === 'string') {
        message = data.error;
      } else if (err.response) {
        message = `Server error (${status})`;
      } else if (err.request) {
        message = `Network error — cannot reach server (${err.config?.baseURL || ''}${err.config?.url || ''})`;
      } else {
        message = err.message || `Registration failed (${status})`;
      }

      console.error(`[register] ${status}:`, message, err);
      set({ isLoading: false, error: message });
      throw new Error(message);
    }
  },

  fetchProfile: async () => {
    try {
      const res = await api.get('/auth/me');
      const current = get().activeCompanyId || localStorage.getItem('active_company_id');
      const activeCompanyId = resolveActiveCompanyId(res.data, current);
      if (activeCompanyId) {
        localStorage.setItem('active_company_id', activeCompanyId);
      }
      set({ user: withActiveCompanyFirst(res.data, activeCompanyId), activeCompanyId, isAuthenticated: true });
    } catch {
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
      clearAuthCookie();
      set({
        user: null,
        token: null,
        refreshToken: null,
        activeCompanyId: null,
        isAuthenticated: false,
      });
    }
  },

  logout: async () => {
    try {
      const token = get().refreshToken;
      await api.post('/auth/logout', { refreshToken: token });
    } catch (err) {
      console.error('[logout] 退出请求失败（已忽略）:', err);
    }
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    clearAuthCookie();
    // Electron 环境：清除 safeStorage 中的 token
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.auth.clearToken().catch((error) => { console.error('[Frontend] background operation failed:', error); });
    }
    set({
      user: null,
      token: null,
      refreshToken: null,
      activeCompanyId: null,
      isAuthenticated: false,
      error: null,
    });
  },

  clearError: () => set({ error: null }),
  setActiveCompany: (companyId) => {
    if (getForcedCompanySlug()) return;
    localStorage.setItem('active_company_id', companyId);
    const user = get().user;
    set({ activeCompanyId: companyId, user: user ? withActiveCompanyFirst(user, companyId) : user });
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  },
}));
