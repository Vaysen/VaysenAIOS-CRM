'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { useT } from '@/i18n/use-translation';

interface AttributeTemplate {
  id: string;
  name: string;
  type: string;
  options: string[] | null;
  unit: string | null;
  required: boolean;
  sortOrder: number;
}

interface CategoryRecord {
  id: string;
  name: string;
  attributeTemplates: AttributeTemplate[];
}

interface ProductData {
  sku: string;
  name: string;
  categoryId: string;
  description: string;
  basePrice: number;
  currency: string;
  attributes: Record<string, any>;
  images?: string[];
}

interface ProductFormProps {
  initialData?: ProductData & { id?: string };
  isEdit?: boolean;
}

export default function ProductForm({ initialData, isEdit }: ProductFormProps) {
  const { t } = useT();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [categories, setCategories] = useState<CategoryRecord[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<CategoryRecord | null>(null);

  const [sku, setSku] = useState(initialData?.sku || '');
  const [name, setName] = useState(initialData?.name || '');
  const [categoryId, setCategoryId] = useState(initialData?.categoryId || '');
  const [description, setDescription] = useState(initialData?.description || '');
  const [basePrice, setBasePrice] = useState(String(initialData?.basePrice || ''));
  const [currency, setCurrency] = useState(initialData?.currency || 'USD');
  const [attributes, setAttributes] = useState<Record<string, any>>(initialData?.attributes || {});
  const [images, setImages] = useState<string[]>(initialData?.images || []);

  useEffect(() => {
    api.get('/categories').then((res) => setCategories(res.data || [])).catch((error) => { console.error('[Frontend] background operation failed:', error); });
  }, []);

  const fetchCategoryDetail = useCallback(async (id: string) => {
    const cat = categories.find((c) => c.id === id);
    if (cat) {
      setSelectedCategory(cat);
      // Initialize attributes for new fields
      const newAttrs: Record<string, any> = { ...attributes };
      cat.attributeTemplates.forEach((tpl) => {
        if (!(tpl.name in newAttrs)) {
          if (tpl.type === 'BOOLEAN') newAttrs[tpl.name] = false;
          else if (tpl.type === 'MULTI_SELECT') newAttrs[tpl.name] = [];
          else newAttrs[tpl.name] = '';
        }
      });
      setAttributes(newAttrs);
    }
  }, [categories, attributes]);

  useEffect(() => {
    if (categoryId) fetchCategoryDetail(categoryId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId, categories]);

  const handleCategoryChange = (id: string) => {
    setCategoryId(id);
    setSelectedCategory(null);
  };

  const handleAttrChange = (name: string, value: any) => {
    setAttributes((prev) => ({ ...prev, [name]: value }));
  };

  const handleMultiSelectToggle = (name: string, option: string) => {
    setAttributes((prev) => {
      const current: string[] = prev[name] || [];
      if (current.includes(option)) return { ...prev, [name]: current.filter((x) => x !== option) };
      return { ...prev, [name]: [...current, option] };
    });
  };

  const handleSubmit = async () => {
    if (!sku.trim() || !name.trim() || !categoryId) {
      alert('请填写必填字段');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        sku: sku.trim(),
        name: name.trim(),
        categoryId,
        description: description.trim(),
        basePrice: parseFloat(basePrice) || 0,
        currency,
        attributes,
        images,
      };

      if (isEdit && initialData?.id) {
        await api.patch(`/products/${initialData.id}`, payload);
      } else {
        await api.post('/products', payload);
      }
      router.push('/products');
    } catch (err: any) {
      alert(err.response?.data?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const renderAttributeInput = (tpl: AttributeTemplate) => {
    const value = attributes[tpl.name];

    switch (tpl.type) {
      case 'TEXT':
        return (
          <input
            type="text"
            value={value || ''}
            onChange={(e) => handleAttrChange(tpl.name, e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
            placeholder={tpl.name}
          />
        );
      case 'NUMBER':
        return (
          <input
            type="number"
            step="any"
            value={value || ''}
            onChange={(e) => handleAttrChange(tpl.name, e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
            placeholder={tpl.name}
          />
        );
      case 'SELECT':
        return (
          <select
            value={value || ''}
            onChange={(e) => handleAttrChange(tpl.name, e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
          >
            <option value="">--</option>
            {(tpl.options || []).map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        );
      case 'MULTI_SELECT':
        return (
          <div className="flex flex-wrap gap-2">
            {(tpl.options || []).map((opt) => {
              const selected = Array.isArray(value) && value.includes(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => handleMultiSelectToggle(tpl.name, opt)}
                  className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                    selected
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                  }`}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        );
      case 'BOOLEAN':
        return (
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={!!value}
              onChange={(e) => handleAttrChange(tpl.name, e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-700 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">{value ? t('common.yes') : t('common.no')}</span>
          </label>
        );
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          {isEdit ? t('products.editProduct') : t('products.createProduct')}
        </h3>

        {/* Standard fields */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('products.sku')} *
            </label>
            <input
              type="text"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder={t('products.sku')}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('products.productName')} *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder={t('products.productName')}
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('products.category')} *
          </label>
          <select
            value={categoryId}
            onChange={(e) => handleCategoryChange(e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
          >
            <option value="">{t('products.selectCategory')}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('products.description')}
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
            placeholder={t('products.description')}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('products.basePrice')}
            </label>
            <input
              type="number"
              step="0.01"
              value={basePrice}
              onChange={(e) => setBasePrice(e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="0.00"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('products.currency')}
            </label>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
            >
              <option value="USD">USD</option>
              <option value="CNY">CNY</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
              <option value="JPY">JPY</option>
            </select>
          </div>
        </div>
      </div>

      {(images.length > 0 || attributes.localPath) && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6 space-y-3">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">目录册 / 素材文件</h3>
          {(attributes.localPath || images[0]) && (
            <div className="rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-900">
              <p className="text-xs text-gray-400">本地文件路径</p>
              <p className="mt-1 break-all font-mono text-gray-800 dark:text-gray-200">{attributes.localPath || images[0]}</p>
            </div>
          )}
          <textarea
            value={images.join('\n')}
            onChange={(e) => setImages(e.target.value.split('\n').map((item) => item.trim()).filter(Boolean))}
            rows={Math.min(6, Math.max(2, images.length))}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
            placeholder="每行一个图片、PDF 或目录册本地路径"
          />
          <p className="text-xs text-gray-400">浏览器不能直接预览 D 盘 PDF，这里先显示索引路径；后续可加“上传到服务器并在线预览”。</p>
        </div>
      )}

      {/* Dynamic Attributes */}
      {selectedCategory && selectedCategory.attributeTemplates.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {t('products.attributes')} ({selectedCategory.name})
          </h3>
          {selectedCategory.attributeTemplates.map((tpl) => (
            <div key={tpl.id}>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {tpl.name}
                {tpl.required && <span className="text-red-500 ml-1">*</span>}
                {tpl.unit && <span className="text-gray-400 text-xs ml-1">({tpl.unit})</span>}
              </label>
              {renderAttributeInput(tpl)}
            </div>
          ))}
        </div>
      )}

      {selectedCategory && selectedCategory.attributeTemplates.length === 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6 text-center text-gray-400 text-sm">
          该品类暂无规格属性定义，可先在品类管理中配置属性模板
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSubmit}
          disabled={saving}
          className="rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? t('common.loading') : t('common.save')}
        </button>
        <button
          onClick={() => router.push('/products')}
          className="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
