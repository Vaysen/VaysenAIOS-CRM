'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { useT } from '@/i18n/use-translation';
import { Plus, Pencil, Trash2, ChevronDown, ChevronRight, X, Check } from 'lucide-react';

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
  description?: string;
  sortOrder: number;
  isActive: boolean;
  attributeTemplates: AttributeTemplate[];
}

const ATTR_TYPES = ['TEXT', 'NUMBER', 'SELECT', 'MULTI_SELECT', 'BOOLEAN'] as const;

export default function CategoriesPage() {
  const { t } = useT();
  const [categories, setCategories] = useState<CategoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Category form
  const [showCatForm, setShowCatForm] = useState(false);
  const [editingCat, setEditingCat] = useState<CategoryRecord | null>(null);
  const [catName, setCatName] = useState('');
  const [catDesc, setCatDesc] = useState('');

  // Attribute form
  const [attrForCategory, setAttrForCategory] = useState<string | null>(null);
  const [editingAttr, setEditingAttr] = useState<AttributeTemplate | null>(null);
  const [attrName, setAttrName] = useState('');
  const [attrType, setAttrType] = useState<string>('TEXT');
  const [attrOptions, setAttrOptions] = useState('');
  const [attrUnit, setAttrUnit] = useState('');
  const [attrRequired, setAttrRequired] = useState(false);

  const fetchCategories = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.get('/categories');
      setCategories(res.data || []);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load categories');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCategories(); }, [fetchCategories]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Category actions
  const openNewCat = () => {
    setEditingCat(null);
    setCatName('');
    setCatDesc('');
    setShowCatForm(true);
  };

  const openEditCat = (c: CategoryRecord) => {
    setEditingCat(c);
    setCatName(c.name);
    setCatDesc(c.description || '');
    setShowCatForm(true);
  };

  const saveCategory = async () => {
    if (!catName.trim()) return;
    try {
      if (editingCat) {
        await api.patch(`/categories/${editingCat.id}`, { name: catName.trim(), description: catDesc.trim() });
      } else {
        await api.post('/categories', { name: catName.trim(), description: catDesc.trim() });
      }
      setShowCatForm(false);
      fetchCategories();
    } catch (err: any) {
      alert(err.response?.data?.message || 'Failed to save');
    }
  };

  const deleteCategory = async (c: CategoryRecord) => {
    if (!confirm(t('categories.deleteCategoryConfirm', { name: c.name }))) return;
    try {
      await api.delete(`/categories/${c.id}`);
      fetchCategories();
    } catch (err: any) {
      alert(err.response?.data?.message || 'Failed to delete');
    }
  };

  // Attribute actions
  const openNewAttr = (categoryId: string) => {
    setAttrForCategory(categoryId);
    setEditingAttr(null);
    setAttrName('');
    setAttrType('TEXT');
    setAttrOptions('');
    setAttrUnit('');
    setAttrRequired(false);
  };

  const openEditAttr = (categoryId: string, attr: AttributeTemplate) => {
    setAttrForCategory(categoryId);
    setEditingAttr(attr);
    setAttrName(attr.name);
    setAttrType(attr.type);
    setAttrOptions((attr.options || []).join('\n'));
    setAttrUnit(attr.unit || '');
    setAttrRequired(attr.required);
  };

  const saveAttribute = async () => {
    if (!attrName.trim() || !attrForCategory) return;
    try {
      const payload: any = {
        name: attrName.trim(),
        type: attrType,
        unit: attrUnit.trim() || null,
        required: attrRequired,
        options: ['SELECT', 'MULTI_SELECT'].includes(attrType) && attrOptions.trim()
          ? attrOptions.split('\n').map((s: string) => s.trim()).filter(Boolean)
          : null,
      };
      if (editingAttr) {
        await api.patch(`/categories/${attrForCategory}/attributes/${editingAttr.id}`, payload);
      } else {
        await api.post(`/categories/${attrForCategory}/attributes`, payload);
      }
      setAttrForCategory(null);
      fetchCategories();
    } catch (err: any) {
      alert(err.response?.data?.message || 'Failed to save');
    }
  };

  const deleteAttribute = async (categoryId: string, attr: AttributeTemplate) => {
    if (!confirm(t('categories.deleteAttributeConfirm', { name: attr.name }))) return;
    try {
      await api.delete(`/categories/${categoryId}/attributes/${attr.id}`);
      fetchCategories();
    } catch (err: any) {
      alert(err.response?.data?.message || 'Failed to delete');
    }
  };

  const getTypeLabel = (type: string) => t(`categories.types.${type}` as any) || type;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{t('categories.title')}</h2>
          <p className="text-gray-500 dark:text-gray-400">{t('categories.noCategoriesHint')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/products"
            className="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            {t('products.title')}
          </Link>
          <button
            onClick={openNewCat}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 flex items-center gap-2"
          >
            <Plus className="h-4 w-4" />
            {t('categories.createCategory')}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Category Form Modal */}
      {showCatForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {editingCat ? t('categories.editCategory') : t('categories.createCategory')}
            </h3>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('categories.name')}</label>
              <input
                type="text"
                value={catName}
                onChange={(e) => setCatName(e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder={t('categories.name')}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('categories.description')}</label>
              <input
                type="text"
                value={catDesc}
                onChange={(e) => setCatDesc(e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder={t('categories.description')}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowCatForm(false)}
                className="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={saveCategory}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Attribute Form Modal */}
      {attrForCategory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {editingAttr ? t('categories.editAttribute') : t('categories.addAttribute')}
            </h3>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('categories.attributeName')}</label>
              <input
                type="text"
                value={attrName}
                onChange={(e) => setAttrName(e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder={t('categories.attributeName')}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('categories.attributeType')}</label>
              <select
                value={attrType}
                onChange={(e) => setAttrType(e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
              >
                {ATTR_TYPES.map((t2) => (
                  <option key={t2} value={t2}>{getTypeLabel(t2)}</option>
                ))}
              </select>
            </div>
            {['SELECT', 'MULTI_SELECT'].includes(attrType) && (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('categories.options')}</label>
                <textarea
                  value={attrOptions}
                  onChange={(e) => setAttrOptions(e.target.value)}
                  rows={4}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder={t('categories.optionsHint')}
                />
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('categories.unit')}</label>
                <input
                  type="text"
                  value={attrUnit}
                  onChange={(e) => setAttrUnit(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder={t('categories.unit')}
                />
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={attrRequired}
                    onChange={(e) => setAttrRequired(e.target.checked)}
                    className="rounded border-gray-300 dark:border-gray-700 text-blue-600 focus:ring-blue-500"
                  />
                  {t('categories.required')}
                </label>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setAttrForCategory(null)}
                className="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={saveAttribute}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Categories List */}
      {loading ? (
        <div className="text-center text-gray-400 py-8">{t('common.loading')}</div>
      ) : categories.length === 0 ? (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-8 text-center text-gray-400">
          {t('categories.noCategories')}
        </div>
      ) : (
        <div className="space-y-3">
          {categories.map((c) => (
            <div key={c.id} className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 overflow-hidden">
              <div className="flex items-center justify-between p-4">
                <button onClick={() => toggleExpand(c.id)} className="flex items-center gap-2 text-left">
                  {expanded.has(c.id)
                    ? <ChevronDown className="h-5 w-5 text-gray-400" />
                    : <ChevronRight className="h-5 w-5 text-gray-400" />
                  }
                  <span className="font-semibold text-gray-900 dark:text-white">{c.name}</span>
                  {c.description && (
                    <span className="text-xs text-gray-400 ml-2">{c.description}</span>
                  )}
                  <span className="text-xs text-gray-400 ml-2">
                    ({c.attributeTemplates.length} attributes)
                  </span>
                </button>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => openEditCat(c)}
                    className="rounded p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => deleteCategory(c)}
                    className="rounded p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {expanded.has(c.id) && (
                <div className="border-t border-gray-200 dark:border-gray-800 px-4 py-3">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-medium text-gray-500 dark:text-gray-400">{t('categories.attributes')}</span>
                    <button
                      onClick={() => openNewAttr(c.id)}
                      className="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-1"
                    >
                      <Plus className="h-3 w-3" />
                      {t('categories.addAttribute')}
                    </button>
                  </div>
                  {c.attributeTemplates.length === 0 ? (
                    <p className="text-xs text-gray-400 py-2">No attributes defined yet</p>
                  ) : (
                    <div className="space-y-1">
                      {c.attributeTemplates.map((attr) => (
                        <div key={attr.id} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-gray-50 dark:hover:bg-gray-900/30">
                          <div className="flex items-center gap-3">
                            <span className="text-sm text-gray-900 dark:text-white">{attr.name}</span>
                            <span className="inline-flex rounded-full px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                              {getTypeLabel(attr.type)}
                            </span>
                            {attr.unit && (
                              <span className="text-xs text-gray-400">({attr.unit})</span>
                            )}
                            {attr.required && (
                              <span className="text-xs text-red-500">*</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => openEditAttr(c.id, attr)}
                              className="rounded p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => deleteAttribute(c.id, attr)}
                              className="rounded p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
