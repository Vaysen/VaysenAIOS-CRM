'use client';

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import api from '@/lib/api';
import { FileText, X, Sparkles, Loader2, CheckCircle2, RefreshCw, ExternalLink, Calculator, Package, Plus, Trash2, Search, DollarSign, ChevronDown, ChevronRight, FolderOpen, Send } from 'lucide-react';
import { sanitizeRichHtml } from '@/lib/sanitize-rich-html';

interface Props {
  conversationId: string;
  leadId: string;
  type: 'quote' | 'pi' | 'sample';
  onClose: () => void;
  placement?: 'center' | 'right';
}

interface LineItem {
  productCode?: string;
  productName: string;
  material?: string;
  size?: string;
  thickness?: string;
  color?: string;
  printing?: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  totalPrice: number;
  productSpecId?: string;
  catalogItemId?: string;
  notes?: string;
}

const TYPE_LABELS: Record<string, string> = { quote: '报价单', pi: 'PI 形式发票', sample: '样品单' };
const TYPE_ICONS: Record<string, any> = { quote: FileText, pi: Calculator, sample: Package };

export function QuotePIForm({ conversationId, leadId, type, onClose, placement = 'center' }: Props) {
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [quoteResult, setQuoteResult] = useState<any>(null);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [tradeTerms, setTradeTerms] = useState('FOB Shenzhen');
  const [paymentTerms, setPaymentTerms] = useState('T/T 30% deposit, 70% before shipment');
  const [deliveryTime, setDeliveryTime] = useState('15-20 days');
  const [currency, setCurrency] = useState('USD');
  const [discount, setDiscount] = useState(0);
  const [taxRate, setTaxRate] = useState(0);
  const [notes, setNotes] = useState('');
  const [sampleFee, setSampleFee] = useState<number | ''>('');
  const [moldFee, setMoldFee] = useState<number | ''>('');
  const [showPreview, setShowPreview] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [sendingQuote, setSendingQuote] = useState(false);
  const [preparedQuoteFile, setPreparedQuoteFile] = useState<{
    preparedFileId: string;
    quoteId: string;
    filename: string;
    size: number;
    sha256: string;
  } | null>(null);
  const [quoteFileError, setQuoteFileError] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [showProductPicker, setShowProductPicker] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    loadAI();
  }, [conversationId, type]);

  const loadAI = async () => {
    setLoading(true);
    try {
      const r = await api.post(`/ai-communications/generate-quote/${conversationId}`, { type });
      const data = r.data;
      setAiEnabled(data?.aiEnabled || false);

      if (data?.lineItems && Array.isArray(data.lineItems) && data.lineItems.length > 0) {
        setLineItems(data.lineItems.map((item: any) => ({
          productCode: item.productCode || '',
          productName: item.productName || 'Custom Packaging',
          material: item.material || '',
          size: item.size || '',
          thickness: item.thickness || '',
          color: item.color || '',
          printing: item.printing || '',
          quantity: item.quantity || 0,
          unit: item.unit || 'pcs',
          unitPrice: item.unitPrice || 0,
          totalPrice: item.totalPrice || (item.quantity || 0) * (item.unitPrice || 0),
          productSpecId: item.productSpecId || '',
        })));
      } else if (data?.fields) {
        const f = data.fields;
        setLineItems([{
          productName: f.productName || 'Custom Packaging',
          material: f.material || '',
          size: f.size || '',
          thickness: f.thickness || '',
          color: f.color || '',
          printing: f.printing || '',
          quantity: parseInt(f.quantity) || 0,
          unit: 'pcs',
          unitPrice: parseFloat(f.unitPrice) || 0,
          totalPrice: parseFloat(f.totalAmount) || 0,
        }]);
      } else {
        setLineItems([{ productName: '', quantity: 0, unit: 'pcs', unitPrice: 0, totalPrice: 0 }]);
      }

      if (data?.tradeTerms) setTradeTerms(data.tradeTerms);
      if (data?.paymentTerms) setPaymentTerms(data.paymentTerms);
      if (data?.deliveryTime) setDeliveryTime(data.deliveryTime);
      if (data?.currency) setCurrency(data.currency);
    } catch (err) {
      const anyErr = err as { response?: { status?: number }; code?: string; message?: string };
      let reason = '未知错误';
      if (anyErr?.response?.status === 401) reason = '登录已失效，请重新登录';
      else if (anyErr?.response?.status && anyErr.response.status >= 500) reason = `服务端异常（${anyErr.response.status}）`;
      else if (anyErr?.code === 'ECONNABORTED' || anyErr?.code === 'ERR_NETWORK') reason = '网络超时或后端离线';
      else if (anyErr?.message) reason = anyErr.message;
      console.error('[QuotePIForm] generate-quote failed:', err);
      setAiEnabled(false);
      setLineItems([{ productName: '', quantity: 0, unit: 'pcs', unitPrice: 0, totalPrice: 0 }]);
      setNotes(`AI 服务暂不可用（${reason}），请手动填写`);
    } finally {
      setLoading(false);
    }
  };

  const updateLineItem = (index: number, field: keyof LineItem, value: any) => {
    setLineItems(prev => prev.map((item, i) => {
      if (i !== index) return item;
      const next = { ...item, [field]: value };
      if (field === 'quantity' || field === 'unitPrice') {
        next.totalPrice = Number((next.quantity * next.unitPrice).toFixed(2));
      }
      return next;
    }));
  };

  const addLineItem = () => {
    setLineItems(prev => [...prev, { productName: '', quantity: 0, unit: 'pcs', unitPrice: 0, totalPrice: 0 }]);
  };

  const removeLineItem = (index: number) => {
    setLineItems(prev => prev.length > 1 ? prev.filter((_, i) => i !== index) : prev);
  };

  const subtotal = lineItems.reduce((sum, item) => sum + item.totalPrice, 0);
  const discountNum = Number(discount) || 0;
  const taxRateNum = Number(taxRate) || 0;
  const sampleFeeNum = Number(sampleFee) || 0;
  const moldFeeNum = Number(moldFee) || 0;
  const taxAmount = ((subtotal - discountNum) * taxRateNum) / 100;
  const totalAmount = subtotal - discountNum + taxAmount + sampleFeeNum + moldFeeNum;

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      const body = {
        leadId,
        conversationId,
        type,
        lineItems: lineItems.map(item => ({
          productCode: item.productCode || undefined,
          productName: item.productName || 'Custom Packaging',
          material: item.material || undefined,
          size: item.size || undefined,
          thickness: item.thickness || undefined,
          color: item.color || undefined,
          printing: item.printing || undefined,
          quantity: item.quantity || 0,
          unit: item.unit,
          unitPrice: item.unitPrice || 0,
          totalPrice: item.totalPrice || 0,
          productSpecId: item.productSpecId || undefined,
          catalogItemId: item.catalogItemId || undefined,
        })),
        currency,
        tradeTerms,
        paymentTerms,
        deliveryTime,
        sampleFee: sampleFee || undefined,
        moldFee: moldFee || undefined,
        discount: discountNum,
        taxRate: taxRateNum,
        notes,
        aiExtracted: aiEnabled,
      };

      const r = await api.post('/quotes', body);
      setQuoteResult(r.data);
      setConfirmed(true);
      void prepareQuoteForDrag(r.data);
    } catch (err: any) {
      alert(err?.response?.data?.message || '创建报价失败，请重试');
    } finally {
      setConfirming(false);
    }
  };

  // 加载预览 HTML
  const loadPreview = async () => {
    if (!quoteResult?.id || previewHtml) return;
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || '/api';
      const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') || '' : '';
      const res = await fetch(`${apiUrl}/quotes/${quoteResult.id}/pi`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const html = await res.text();
      setPreviewHtml(html);
    } catch {
      setPreviewHtml('<p style="color:red;padding:20px;">预览加载失败</p>');
    }
  };

  // 下载 PDF
  const downloadPDF = async () => {
    if (!quoteResult?.id) return;
    setPdfLoading(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || '/api';
      const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') || '' : '';
      const res = await fetch(`${apiUrl}/quotes/${quoteResult.id}/pi`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const html = await res.text();
      // 使用浏览器打印功能生成PDF
      const printWindow = window.open('', '_blank');
      if (printWindow) {
        printWindow.document.write(html);
        printWindow.document.close();
        printWindow.focus();
        setTimeout(() => printWindow.print(), 500);
      }
    } catch {
      alert('PDF生成失败，请重试');
    } finally {
      setPdfLoading(false);
    }
  };

  // WhatsApp 的附件对话框受安全策略保护，改用本地校验副本 + 原生拖拽。
  const prepareQuoteForDrag = async (quote = quoteResult) => {
    if (!quote?.id) return;
    const quoteFiles = window.electronAPI?.quoteFiles;
    if (!quoteFiles) {
      setQuoteFileError('浏览器模式不支持原生拖拽，请使用“下载PDF”。');
      return;
    }
    setSendingQuote(true);
    setQuoteFileError('');
    try {
      const filename = `${quote.referenceNo || quote.id}.pdf`;
      const result = await quoteFiles.prepare(quote.id, filename);
      if (!result.success || !result.data) throw new Error(result.error || '准备报价文件失败');
      setPreparedQuoteFile(result.data);
    } catch (err: any) {
      setQuoteFileError(err?.message || '准备报价文件失败，请重试');
    } finally {
      setSendingQuote(false);
    }
  };

  const startQuoteDrag = (event: React.DragEvent<HTMLDivElement>) => {
    if (!preparedQuoteFile || !window.electronAPI?.quoteFiles) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    void window.electronAPI.quoteFiles.startDrag(preparedQuoteFile.preparedFileId).then((result) => {
      if (!result.success) setQuoteFileError(result.error || '无法开始文件拖拽');
    });
  };

  const Icon = TYPE_ICONS[type];
  const isRightPlacement = placement === 'right';
  const overlayClassName = isRightPlacement
    ? 'fixed top-16 right-0 bottom-0 z-[2147483647] w-[clamp(420px,32vw,540px)] max-w-[calc(100vw-240px-200px)] flex justify-end bg-black/20'
    : 'fixed inset-0 z-[2147483647] flex items-center justify-center p-4 bg-black/30';
  const panelClassName = isRightPlacement
    ? 'relative h-full w-full bg-white border-l border-gray-200 shadow-2xl flex flex-col overflow-hidden'
    : 'relative w-[460px] max-h-[80vh] bg-white border border-gray-200 rounded-xl shadow-2xl flex flex-col overflow-hidden';

  const content = (
    <div data-testid="quote-pi-form-overlay" className={overlayClassName} onClick={onClose}>
    <div data-testid="quote-pi-form" className={panelClassName} onClick={(e) => e.stopPropagation()}>
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b bg-gradient-to-r from-blue-50 to-white">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-blue-600" />
          <span className="text-sm font-bold text-gray-900">AI 辅助{TYPE_LABELS[type]}</span>
          {aiEnabled && (
            <span className="text-[9px] bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
              <Sparkles className="w-2.5 h-2.5" />AI
            </span>
          )}
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-0.5"><X className="w-4 h-4" /></button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
            <p className="text-xs text-gray-500">AI 正在分析对话并提取产品信息...</p>
          </div>
        ) : confirmed ? (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <CheckCircle2 className="w-10 h-10 text-green-500" />
            <p className="text-sm font-semibold text-gray-900">{TYPE_LABELS[type]}已生成</p>
            {quoteResult && (
              <div className="text-center space-y-2 w-full">
                <p className="text-xs text-gray-500">编号: {quoteResult.referenceNo}</p>
                {quoteResult.totalAmount && <p className="text-lg font-bold text-gray-900">{currency} {Number(quoteResult.totalAmount).toLocaleString()}</p>}
                <p className="text-xs text-gray-400">{lineItems.length} 项产品</p>
                <div className="flex items-center justify-center gap-2 mt-3 flex-wrap">
                  <a href={`/quotes/${quoteResult.id}`} target="_blank" className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                    <ExternalLink className="w-3 h-3" />查看详情
                  </a>
                  <button
                    onClick={() => setShowPreview(true)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-md"
                  >
                    <FileText className="w-3 h-3" />弹窗预览
                  </button>
                  <button
                    onClick={() => downloadPDF()}
                    disabled={pdfLoading}
                    className="inline-flex items-center gap-1 text-xs font-medium text-white bg-green-600 hover:bg-green-700 px-3 py-1.5 rounded-md disabled:opacity-40"
                  >
                    {pdfLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}下载PDF
                  </button>
                  <button
                    onClick={() => prepareQuoteForDrag()}
                    disabled={sendingQuote}
                    className="inline-flex items-center gap-1 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 px-3 py-1.5 rounded-md disabled:opacity-40"
                  >
                    {sendingQuote ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                    {preparedQuoteFile ? '重新准备' : '准备拖拽'}
                  </button>
                </div>
                {preparedQuoteFile && (
                  <div
                    draggable
                    onDragStart={startQuoteDrag}
                    data-testid="quote-file-drag-region"
                    className="mx-auto mt-4 max-w-sm cursor-grab select-none rounded-xl border-2 border-dashed border-emerald-400 bg-emerald-50 px-4 py-3 text-left active:cursor-grabbing"
                  >
                    <div className="flex items-center gap-3">
                      <FileText className="h-8 w-8 shrink-0 text-emerald-600" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-gray-900">{preparedQuoteFile.filename}</p>
                        <p className="mt-0.5 text-[11px] text-emerald-700">已就绪：按住此卡片拖到左侧 WhatsApp 聊天窗口</p>
                        <p className="text-[10px] text-gray-500">放入对话框后，由你人工点击 WhatsApp 的发送按钮</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void window.electronAPI?.quoteFiles.openFolder(preparedQuoteFile.preparedFileId);
                      }}
                      className="mt-2 inline-flex items-center gap-1 text-[11px] text-gray-600 hover:text-gray-900"
                    >
                      <FolderOpen className="h-3 w-3" />打开本地文件位置
                    </button>
                  </div>
                )}
                {quoteFileError && <p className="mt-2 text-xs text-red-600">{quoteFileError}</p>}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* AI status */}
            {aiEnabled ? (
              <div className="text-[10px] text-blue-600 bg-blue-50 rounded px-2 py-1 flex items-center justify-between">
                <span className="flex items-center gap-1"><Sparkles className="w-3 h-3" />AI 建议 — 请人工核实后确认</span>
                <button onClick={loadAI} className="text-blue-500 hover:underline flex items-center gap-0.5">
                  <RefreshCw className="w-2.5 h-2.5" />重新分析
                </button>
              </div>
            ) : (
              <div className="text-[10px] text-amber-600 bg-amber-50 rounded px-2 py-1 flex items-center gap-1">
                <Sparkles className="w-3 h-3" />AI 服务未连接，手动模式
              </div>
            )}

            {/* Currency & Terms */}
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] text-gray-500 mb-0.5 block">币种</label>
                <select value={currency} onChange={e => setCurrency(e.target.value)}
                  className="w-full border rounded px-2 py-1.5 text-[11px] outline-none focus:border-blue-400">
                  <option value="USD">USD</option>
                  <option value="CNY">CNY</option>
                  <option value="EUR">EUR</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-gray-500 mb-0.5 block">贸易条款</label>
                <input value={tradeTerms} onChange={e => setTradeTerms(e.target.value)}
                  className="w-full border rounded px-2 py-1.5 text-[11px] outline-none focus:border-blue-400" />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 mb-0.5 block">交期</label>
                <input value={deliveryTime} onChange={e => setDeliveryTime(e.target.value)}
                  className="w-full border rounded px-2 py-1.5 text-[11px] outline-none focus:border-blue-400" />
              </div>
            </div>

            {/* Line Items */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-gray-700">产品行项目 ({lineItems.length})</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowProductPicker(true)}
                    className="text-[10px] text-white bg-blue-600 hover:bg-blue-700 px-2 py-1 rounded-md flex items-center gap-0.5 font-medium"
                  >
                    <Package className="w-3 h-3" />选择产品
                  </button>
                  <button onClick={addLineItem} className="text-[10px] text-blue-600 hover:underline flex items-center gap-0.5">
                    <Plus className="w-3 h-3" />空白行
                  </button>
                </div>
              </div>

              {lineItems.length === 0 && (
                <div className="text-center py-6 border border-dashed border-gray-300 rounded-lg">
                  <Package className="w-6 h-6 text-gray-300 mx-auto mb-1" />
                  <p className="text-[10px] text-gray-400">点击「选择产品」从产品库添加</p>
                </div>
              )}

              {lineItems.map((item, idx) => (
                <LineItemCard
                  key={idx}
                  index={idx}
                  item={item}
                  currency={currency}
                  onUpdate={updateLineItem}
                  onRemove={removeLineItem}
                  canRemove={lineItems.length > 1}
                />
              ))}
            </div>

            {/* Totals */}
            <div className="bg-gray-50 rounded-lg p-3 space-y-1.5">
              <div className="flex justify-between text-[11px]">
                <span className="text-gray-600">小计</span>
                <span className="font-medium text-gray-900">{currency} {subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
              <div className="flex justify-between text-[11px] items-center">
                <span className="text-gray-600">折扣</span>
                <input type="number" value={discount} onChange={e => setDiscount(Number(e.target.value) || 0)}
                  className="w-20 border rounded px-1.5 py-0.5 text-[11px] text-right" />
              </div>
              <div className="flex justify-between text-[11px] items-center">
                <span className="text-gray-600">税率 (%)</span>
                <input type="number" value={taxRate} onChange={e => setTaxRate(Number(e.target.value) || 0)}
                  className="w-20 border rounded px-1.5 py-0.5 text-[11px] text-right" />
              </div>
              {taxAmount > 0 && (
                <div className="flex justify-between text-[11px]">
                  <span className="text-gray-600">税额</span>
                  <span className="text-gray-900">{currency} {taxAmount.toFixed(2)}</span>
                </div>
              )}
              {sampleFeeNum > 0 && (
                <div className="flex justify-between text-[11px]">
                  <span className="text-gray-600">样品费</span>
                  <span className="text-gray-900">{currency} {sampleFeeNum.toFixed(2)}</span>
                </div>
              )}
              {moldFeeNum > 0 && (
                <div className="flex justify-between text-[11px]">
                  <span className="text-gray-600">开模费</span>
                  <span className="text-gray-900">{currency} {moldFeeNum.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between items-center pt-1.5 border-t">
                <span className="text-xs font-semibold text-gray-700">总计</span>
                <span className="text-lg font-bold text-blue-700">{currency} {totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
            </div>

            {/* Payment & Notes */}
            <div>
              <label className="text-[10px] text-gray-500 mb-0.5 block">付款方式</label>
              <input value={paymentTerms} onChange={e => setPaymentTerms(e.target.value)}
                className="w-full border rounded px-2.5 py-1.5 text-[11px] outline-none focus:border-blue-400" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-gray-500 mb-0.5 block">样品费 ({currency})</label>
                <input type="number" value={sampleFee} onChange={e => setSampleFee(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full border rounded px-2.5 py-1.5 text-[11px] outline-none focus:border-blue-400" />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 mb-0.5 block">开模费 ({currency})</label>
                <input type="number" value={moldFee} onChange={e => setMoldFee(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full border rounded px-2.5 py-1.5 text-[11px] outline-none focus:border-blue-400" />
              </div>
            </div>
            <div>
              <label className="text-[10px] text-gray-500 mb-0.5 block">备注</label>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                className="w-full border rounded px-2.5 py-1.5 text-[11px] outline-none focus:border-blue-400 resize-none" />
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      {!loading && !confirmed && (
        <div className="shrink-0 border-t px-4 py-3 flex gap-2">
          <button onClick={onClose} className="flex-1 py-2 text-xs border rounded-md text-gray-600 hover:bg-gray-50">取消</button>
          <button onClick={handleConfirm} disabled={confirming || lineItems.length === 0}
            className="flex-1 py-2 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 font-medium flex items-center justify-center gap-1">
            {confirming ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
            {confirming ? '生成中...' : `确认生成 (${currency} ${totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })})`}
          </button>
        </div>
      )}

      {/* 预览弹窗 */}
      {showPreview && quoteResult?.id && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowPreview(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-[900px] max-h-[90vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b bg-gradient-to-r from-blue-50 to-white">
              <span className="text-sm font-bold text-gray-900">报价单预览 — {quoteResult.referenceNo}</span>
              <div className="flex items-center gap-2">
                <button onClick={downloadPDF} disabled={pdfLoading}
                  className="text-xs bg-green-600 text-white px-3 py-1.5 rounded-md hover:bg-green-700 disabled:opacity-40 flex items-center gap-1">
                  {pdfLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}下载PDF
                </button>
                <button onClick={() => setShowPreview(false)} className="text-gray-400 hover:text-gray-600 p-0.5">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              <PreviewContent quoteId={quoteResult.id} />
            </div>
          </div>
        </div>
      )}

      {/* 产品选择器模态框 */}
      {showProductPicker && (
        <ProductPickerModal
          currency={currency}
          placement={placement}
          onClose={() => setShowProductPicker(false)}
          onConfirm={(items) => {
            // 移除空白占位行（无规格ID且无数量无价格的行），追加选中的产品
            const nonEmpty = lineItems.filter(i =>
              i.productSpecId || (i.quantity > 0 && i.unitPrice > 0)
            );
            setLineItems([...nonEmpty, ...items]);
            setShowProductPicker(false);
          }}
        />
      )}
    </div>
    </div>
  );

  if (!mounted) return null;
  return createPortal(content, document.body);
}

// 预览内容组件
function PreviewContent({ quoteId }: { quoteId: string }) {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const apiUrl = process.env.NEXT_PUBLIC_API_URL || '/api';
        const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') || '' : '';
        const res = await fetch(`${apiUrl}/quotes/${quoteId}/pi`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const text = await res.text();
        setHtml(text);
      } catch {
        setHtml('<p style="color:red;padding:40px;text-align:center;">预览加载失败，请检查网络连接</p>');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [quoteId]);

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-blue-500" /></div>;
  }
  return <div dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(html) }} />;
}

// ========== Product Picker Modal (全屏模态，彻底解决关闭问题) ==========

interface CategoryData {
  id: string;
  name: string;
  products: ProductWithSpecs[];
}
interface ProductWithSpecs {
  id: string;
  sku: string;
  name: string;
  productCode: string;
  material: string;
  thickness: string;
  productType: string;
  specs: Array<{
    id: string;
    specCode: string;
    size: string;
    unitPrice: number;
    moq: number;
    packPerBundle: number;
    bundleWeightKg: number;
    cartonSize: string;
    catalogItemId?: string;
    costCny?: number;
  }>;
}

// 全局缓存，避免每次打开都重新加载
let _cachedCategories: CategoryData[] | null = null;

function ProductPickerModal({ onClose, onConfirm, currency = 'USD', placement = 'center' }: {
  onClose: () => void;
  onConfirm: (items: LineItem[]) => void;
  currency?: string;
  placement?: 'center' | 'right';
}) {
  const [categories, setCategories] = useState<CategoryData[]>(_cachedCategories || []);
  const [loading, setLoading] = useState(!_cachedCategories);
  const [expandedCat, setExpandedCat] = useState<string | null>(null);
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  // 选中的规格: Map<specId, {product, spec}>
  const [selectedSpecs, setSelectedSpecs] = useState<Map<string, { product: ProductWithSpecs; spec: any }>>(new Map());

  const loadCategories = async () => {
    setLoading(true);
    try {
      const response = await api.get('/products/pricing-catalog', { params: { limit: 168 } });
      const items = response.data?.data || [];
      const byCategory = new Map<string, any[]>();
      items.forEach((item: any) => {
        const list = byCategory.get(item.categoryCn) || [];
        list.push(item);
        byCategory.set(item.categoryCn, list);
      });
      const grouped: CategoryData[] = Array.from(byCategory.entries()).map(([name, specs]) => ({
        id: name,
        name,
        products: [{
          id: name,
          sku: name,
          name,
          productCode: specs[0]?.catalogItemId || name,
          material: '',
          thickness: '',
          productType: 'catalog',
          specs: specs.map((item: any) => ({
            id: item.catalogItemId,
            catalogItemId: item.catalogItemId,
            specCode: item.catalogItemId,
            size: item.size,
            unitPrice: item.saleUsd,
            costCny: item.costCny,
            moq: 1,
            packPerBundle: 0,
            bundleWeightKg: 0,
            cartonSize: item.packageText,
          })),
        }],
      }));
      _cachedCategories = grouped;
      setCategories(grouped);
    } catch {
      setCategories([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (_cachedCategories) {
      setCategories(_cachedCategories);
      setLoading(false);
    } else {
      loadCategories();
    }
  }, []);

  // 搜索时自动展开匹配的品类和产品
  useEffect(() => {
    if (searchQuery) {
      // 自动展开所有有匹配产品的品类
      const matched = filteredCats;
      if (matched.length > 0) {
        setExpandedCat(matched[0].id);
        if (matched[0].products.length === 1) {
          setExpandedProduct(matched[0].products[0].id);
        }
      }
    }
  }, [searchQuery]);

  const filteredCats = searchQuery
    ? categories.map(c => ({
        ...c,
        products: c.products.filter(p =>
          p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          p.sku.toLowerCase().includes(searchQuery.toLowerCase()) ||
          p.productCode.toLowerCase().includes(searchQuery.toLowerCase()) ||
          p.specs.some(s => s.size.toLowerCase().includes(searchQuery.toLowerCase()))
        ),
      })).filter(c => c.products.length > 0)
    : categories;

  const toggleSpec = (product: ProductWithSpecs, spec: any) => {
    setSelectedSpecs(prev => {
      const next = new Map(prev);
      if (next.has(spec.id)) {
        next.delete(spec.id);
      } else {
        next.set(spec.id, { product, spec });
      }
      return next;
    });
  };

  const handleConfirm = () => {
    const items: LineItem[] = [];
    selectedSpecs.forEach(({ product, spec }) => {
      const qty = spec.moq || 1000;
      items.push({
        productCode: product.productCode,
        productName: product.name,
        material: product.material,
        thickness: product.thickness,
        size: spec.size,
        quantity: qty,
        unit: 'pcs',
        unitPrice: parseFloat(spec.unitPrice) || 0,
        totalPrice: qty * (parseFloat(spec.unitPrice) || 0),
        catalogItemId: spec.catalogItemId,
      });
    });
    onConfirm(items);
  };

  const isRightPlacement = placement === 'right';

  return (
    <div
      className={isRightPlacement
        ? 'fixed top-16 right-0 bottom-0 z-[2147483647] w-[clamp(420px,32vw,540px)] max-w-[calc(100vw-240px-200px)] flex justify-end bg-black/30'
        : 'fixed inset-0 bg-black/40 z-[2147483647] flex items-center justify-center p-4'}
      onClick={onClose}
    >
      <div
        className={isRightPlacement
          ? 'bg-white shadow-2xl w-full h-full flex flex-col'
          : 'bg-white rounded-xl shadow-2xl w-[700px] max-h-[85vh] flex flex-col'}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b bg-blue-50">
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-blue-600" />
            <span className="text-sm font-bold text-gray-900">选择产品</span>
            {selectedSpecs.size > 0 && (
              <span className="bg-blue-600 text-white text-[10px] px-2 py-0.5 rounded-full">
                已选 {selectedSpecs.size} 个规格
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="shrink-0 px-4 py-2 border-b">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              type="text"
              placeholder="搜索产品编号、名称或规格..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full border rounded pl-8 pr-3 py-2 text-xs outline-none focus:border-blue-400"
              autoFocus
            />
          </div>
        </div>

        {/* Body — 品类/产品/规格列表 */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
              <span className="ml-2 text-xs text-gray-500">加载产品数据...</span>
            </div>
          )}
          {!loading && filteredCats.length === 0 && (
            <p className="text-xs text-gray-400 text-center py-12">暂无产品数据</p>
          )}
          {!loading && filteredCats.map(cat => (
            <div key={cat.id} className="border-b last:border-0">
              <button
                onClick={() => setExpandedCat(expandedCat === cat.id ? null : cat.id)}
                className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-gray-50 text-left sticky top-0 bg-white z-10"
              >
                {expandedCat === cat.id
                  ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                  : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                <FolderOpen className="w-3.5 h-3.5 text-amber-500" />
                <span className="text-xs font-semibold text-gray-700">{cat.name}</span>
                <span className="text-[10px] text-gray-400">({cat.products.length} 个产品)</span>
              </button>
              {expandedCat === cat.id && cat.products.length === 0 && (
                <p className="px-8 py-2 text-[11px] text-gray-400 italic">该品类暂无产品</p>
              )}
              {expandedCat === cat.id && cat.products.map(product => (
                <div key={product.id}>
                  <button
                    onClick={() => setExpandedProduct(expandedProduct === product.id ? null : product.id)}
                    className="w-full flex items-center gap-2 px-8 py-2 hover:bg-blue-50 text-left"
                  >
                    {expandedProduct === product.id
                      ? <ChevronDown className="w-3 h-3 text-gray-400" />
                      : <ChevronRight className="w-3 h-3 text-gray-400" />}
                    <span className="text-[10px] font-mono text-blue-600">{product.productCode}</span>
                    <span className="text-[11px] text-gray-800">{product.name}</span>
                    {product.material && <span className="text-[9px] text-gray-400">{product.material}</span>}
                    <span className="text-[9px] text-gray-400 ml-auto">{product.specs.length} 个规格</span>
                  </button>
                  {expandedProduct === product.id && product.specs.length > 0 && (
                    <div className="bg-gray-50">
                      {product.specs.map(spec => {
                        const isSelected = selectedSpecs.has(spec.id);
                        return (
                          <label
                            key={spec.id}
                            className="w-full flex items-center gap-2 px-12 py-2 hover:bg-blue-100 cursor-pointer border-t border-gray-100"
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSpec(product, spec)}
                              className="w-3.5 h-3.5 accent-blue-600"
                            />
                            <span className="text-[11px] text-gray-700 font-mono flex-1">{spec.size}</span>
                            {spec.cartonSize && <span className="text-[9px] text-gray-400">箱规:{spec.cartonSize}</span>}
                            {spec.moq && <span className="text-[9px] text-gray-400">MOQ:{spec.moq}</span>}
                            <span className="text-[11px] font-medium text-green-600">{currency === 'CNY' ? '¥' : '$'}{spec.unitPrice}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {expandedProduct === product.id && product.specs.length === 0 && (
                    <p className="px-12 py-1.5 text-[10px] text-gray-400">暂无规格</p>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-t bg-gray-50">
          <span className="text-[11px] text-gray-500">
            {selectedSpecs.size > 0 ? `已选 ${selectedSpecs.size} 个规格，点击确认添加到报价单` : '勾选需要的规格（可多选）'}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-1.5 text-xs text-gray-600 border rounded-md hover:bg-gray-100">
              取消
            </button>
            <button
              onClick={handleConfirm}
              disabled={selectedSpecs.size === 0}
              className="px-4 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-40"
            >
              确认添加 ({selectedSpecs.size})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ========== Line Item Card (简化版 — 产品信息+编辑) ==========

function LineItemCard({ index, item, currency, onUpdate, onRemove, canRemove }: {
  index: number;
  item: LineItem;
  currency: string;
  onUpdate: (index: number, field: keyof LineItem, value: any) => void;
  onRemove: (index: number) => void;
  canRemove: boolean;
}) {
  return (
    <div className="border border-gray-200 rounded-lg p-2.5 space-y-1.5 bg-white">
      {/* 产品信息 */}
      <div className="flex items-center gap-1.5">
        {item.productCode && (
          <span className="text-[9px] text-blue-600 font-mono bg-blue-50 rounded px-1.5 py-0.5 shrink-0">
            {item.productCode}
          </span>
        )}
        <span className="text-[11px] text-gray-800 flex-1 truncate">{item.productName || '未选择产品'}</span>
        {canRemove && (
          <button onClick={() => onRemove(index)} className="text-red-400 hover:text-red-600 p-0.5 shrink-0">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {/* 材质+规格 */}
      <div className="grid grid-cols-2 gap-1.5">
        <input value={item.material || ''} onChange={e => onUpdate(index, 'material', e.target.value)}
          placeholder="材质" className="border rounded px-2 py-1 text-[10px] outline-none focus:border-blue-400" />
        <input value={item.size || ''} onChange={e => onUpdate(index, 'size', e.target.value)}
          placeholder="规格" className="border rounded px-2 py-1 text-[10px] outline-none focus:border-blue-400" />
      </div>
      {/* 数量+单价+总价 */}
      <div className="grid grid-cols-3 gap-1.5">
        <input type="number" value={item.quantity || ''} onChange={e => {
          const qty = parseInt(e.target.value) || 0;
          onUpdate(index, 'quantity', qty);
          onUpdate(index, 'totalPrice', qty * (item.unitPrice || 0));
        }}
          placeholder="数量" className="w-full border rounded px-2 py-1 text-[10px] outline-none focus:border-blue-400" />
        <div className="relative">
          <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[9px] text-gray-400">{currency === 'CNY' ? '¥' : '$'}</span>
          <input type="number" step="0.001" value={item.unitPrice || ''} onChange={e => {
            const price = parseFloat(e.target.value) || 0;
            onUpdate(index, 'unitPrice', price);
            onUpdate(index, 'totalPrice', (item.quantity || 0) * price);
          }}
            placeholder="单价" className="w-full border rounded pl-4 py-1 text-[10px] outline-none focus:border-blue-400" />
        </div>
        <div className="bg-gray-50 rounded px-2 py-1 text-[10px] font-medium text-gray-700 text-right">
          {(item.totalPrice || 0).toFixed(2)}
        </div>
      </div>
    </div>
  );
}
