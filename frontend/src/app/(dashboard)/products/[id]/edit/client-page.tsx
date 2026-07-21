'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { useT } from '@/i18n/use-translation';
import { useRuntimeRouteParam } from '@/lib/use-runtime-route-param';
import ProductForm from '@/components/products/ProductForm';

export default function EditProductPage() {
  const { t } = useT();
  const id = useRuntimeRouteParam('id');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/products/${id}`)
      .then((res) => {
        setData({
          id: res.data.id,
          sku: res.data.sku,
          name: res.data.name,
          categoryId: res.data.categoryId,
          description: res.data.description || '',
          basePrice: Number(res.data.basePrice),
          currency: res.data.currency,
          attributes: res.data.attributes || {},
          images: res.data.images || [],
        });
      })
      .catch((error) => { console.error('[Frontend] background operation failed:', error); })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <div className="text-center text-gray-400 py-8">{t('common.loading')}</div>;
  }

  if (!data) {
    return <div className="text-center text-gray-400 py-8">Product not found</div>;
  }

  return <ProductForm initialData={data} isEdit />;
}
