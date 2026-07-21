'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { QuoteCalculator } from '@/components/products/quote-calculator';
import { Image as ImageIcon, Pencil, Plus, Search, Tags, Trash2, Upload } from 'lucide-react';

interface ProductRecord {
  id: string;
  sku: string;
  name: string;
  category?: { id: string; name: string };
  basePrice: number;
  currency: string;
  attributes: Record<string, any>;
  isActive: boolean;
}

interface CategoryRecord {
  id: string;
  name: string;
}

export default function ProductsPage() {
  const router = useRouter();
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [categories, setCategories] = useState<CategoryRecord[]>([]);
  const [meta, setMeta] = useState({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    const params: any = { page, limit: 20 };
    if (search) params.search = search;
    if (categoryFilter) params.categoryId = categoryFilter;
    try {
      const res = await api.get('/products', { params });
      setProducts(res.data.data || []);
      setMeta(res.data.meta || { page: 1, limit: 20, total: 0, totalPages: 0 });
    } finally {
      setLoading(false);
    }
  }, [page, search, categoryFilter]);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);
  useEffect(() => {
    api.get('/categories').then((res) => setCategories(res.data || [])).catch((error) => { console.error('[Frontend] background operation failed:', error); });
  }, []);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`确认删除 ${name}？`)) return;
    await api.delete(`/products/${id}`);
    fetchProducts();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">素材/产品池</h2>
          <p className="text-sm text-gray-500">共 {meta.total} 个产品、图片、目录册或包装素材，可供 AI 写信和报价时调用。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/products/categories" className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300">
            <Tags className="h-4 w-4" />
            分类
          </Link>
          <Link href="/imports?target=products" className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300">
            <Upload className="h-4 w-4" />
            批量导入
          </Link>
          <Link href="/products/new" className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
            <Plus className="h-4 w-4" />
            新增素材
          </Link>
        </div>
      </div>

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
        批量导入建议字段：SKU、产品名称、分类、价格、币种、镜片材质、镜框材质、MOQ、图片链接、目录册链接、备注。
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-72 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="搜索 SKU、产品名、素材名..."
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-10 pr-3 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => { setCategoryFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800"
        >
          <option value="">全部分类</option>
          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500 dark:border-gray-800 dark:bg-gray-900">
            <tr>
              <th className="px-4 py-3">编号</th>
              <th className="px-4 py-3">名称</th>
              <th className="px-4 py-3">分类</th>
              <th className="px-4 py-3">参考价格</th>
              <th className="px-4 py-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-400">加载中...</td></tr>
            ) : products.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-400">暂无素材或产品</td></tr>
            ) : products.map((product) => (
              <tr key={product.id} className="hover:bg-gray-50 dark:hover:bg-gray-900/40">
                <td className="px-4 py-3 font-mono text-xs text-gray-500">{product.sku}</td>
                <td className="px-4 py-3">
                  <Link href={`/products/${product.id}/edit`} className="inline-flex items-center gap-2 font-medium text-blue-600 hover:underline">
                    <ImageIcon className="h-4 w-4" />
                    {product.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-gray-500">{product.category?.name || '-'}</td>
                <td className="px-4 py-3 font-semibold text-gray-900 dark:text-white">{formatPrice(product.basePrice, product.currency)}</td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    <button onClick={() => router.push(`/products/${product.id}/edit`)} className="rounded p-1.5 text-gray-400 hover:bg-blue-50 hover:text-blue-600">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button onClick={() => handleDelete(product.id, product.name)} className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-500">第 {meta.page} / {meta.totalPages} 页，共 {meta.total} 条</span>
          <div className="flex gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50">上一页</button>
            <button onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))} disabled={page >= meta.totalPages} className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50">下一页</button>
          </div>
        </div>
      )}

      <QuoteCalculator />
    </div>
  );
}

function formatPrice(price: number, currency: string) {
  return `${currency === 'USD' ? '$' : `${currency} `}${Number(price || 0).toFixed(2)}`;
}
