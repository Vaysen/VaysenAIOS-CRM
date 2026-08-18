import axios from 'axios';
import { getRuntimeApiBaseUrl } from './electron/runtime-config';

const api = axios.create({
  baseURL: getRuntimeApiBaseUrl(),
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
  timeout: 15000, // 15秒超时，避免无限等待
});

// 网络错误自动重试（最多2次）
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config as any;
    if (!config) return Promise.reject(error);

    // 只重试 GET 请求和网络错误（不重试 POST/PATCH 等写操作）
    const isGet = (config.method || 'get').toLowerCase() === 'get';
    const isNetworkError = !error.response || error.code === 'ECONNABORTED' || error.code === 'ERR_NETWORK';
    const hasRetried = config._retryCount || 0;

    if (isGet && isNetworkError && hasRetried < 2) {
      config._retryCount = hasRetried + 1;
      console.log(`[API] 重试 ${config._retryCount}/2: ${config.url}`);
      await new Promise(r => setTimeout(r, 500 * config._retryCount)); // 延迟递增
      return api(config);
    }

    return Promise.reject(error);
  }
);

api.interceptors.request.use((config) => {
  // Web settings can change without a rebuild. Electron deliberately remains
  // on /api so the main-process LAN proxy is the single target source.
  config.baseURL = getRuntimeApiBaseUrl();
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('access_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    const activeCompanyId = localStorage.getItem('active_company_id');
    if (activeCompanyId) {
      config.headers['X-Company-Id'] = activeCompanyId;
    }
  }
  return config;
});

// Refresh token mutex — prevents concurrent refresh calls from racing
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
}> = [];

function processQueue(error: Error | null, token: string | null = null) {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) {
      reject(error);
    } else {
      resolve(token);
    }
  });
  failedQueue = [];
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      // If a refresh is already in progress, queue this request instead of racing
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((token) => {
          originalRequest.headers.Authorization = `Bearer ${token}`;
          return api(originalRequest);
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const electronAuth = typeof window !== 'undefined'
          ? window.electronAPI?.auth
          : undefined;
        const refreshed = electronAuth
          ? await electronAuth.refreshSession()
          : (await axios.post(
              `${getRuntimeApiBaseUrl()}/auth/refresh`,
              {},
              { withCredentials: true },
            )).data;
        const { accessToken } = refreshed;
        localStorage.setItem('access_token', accessToken);
        localStorage.removeItem('refresh_token');

        // Wake up all queued requests with the new token
        processQueue(null, accessToken);

        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        // Refresh failed — reject all queued requests and redirect to login
        processQueue(refreshError as Error);
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        if (typeof window !== 'undefined') {
          window.location.href = '/login';
        }
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  },
);

export default api;
