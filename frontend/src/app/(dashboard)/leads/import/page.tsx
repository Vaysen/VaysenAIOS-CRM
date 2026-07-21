'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import { Upload, ArrowLeft, Check, X, FileText, AlertTriangle, Sparkles } from 'lucide-react';

const LEAD_FIELD_LABELS: Record<string, string> = {
  companyName: 'Company Name (required)',
  website: 'Website',
  websiteDomain: 'Website Domain',
  country: 'Country',
  city: 'City',
  industry: 'Industry',
  productCategory: 'Product Category',
  businessType: 'Business Type',
  contactName: 'Contact Name',
  contactTitle: 'Contact Title',
  contactEmail: 'Contact Email',
  contactPhone: 'Contact Phone',
  whatsapp: 'WhatsApp',
  linkedinUrl: 'LinkedIn URL',
  facebookUrl: 'Facebook URL',
  sourceUrl: 'Source URL',
  sourceType: 'Source Type',
  sourceKeyword: 'Source Keyword',
  sourceCountry: 'Source Country',
  confidenceScore: 'Confidence Score',
  status: 'Status',
  ownerUserId: 'Owner User ID',
  notes: 'Notes',
  isUncertain: 'Is Uncertain',
};

type Step = 'upload' | 'mapping' | 'confirm' | 'report';

export default function ImportLeadsPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>('upload');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [parseToken, setParseToken] = useState('');
  const [fileName, setFileName] = useState('');
  const [totalRows, setTotalRows] = useState(0);
  const [headers, setHeaders] = useState<string[]>([]);
  const [fieldMapping, setFieldMapping] = useState<Record<string, string>>({});
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([]);
  const [validCount, setValidCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [validationErrors, setValidationErrors] = useState<any[]>([]);

  const [importResult, setImportResult] = useState<any>(null);
  const [aiMappingLoading, setAiMappingLoading] = useState(false);
  const [aiMappingNotes, setAiMappingNotes] = useState<string[]>([]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      setError(null);
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await api.post('/imports/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      const data = res.data;
      setParseToken(data.parseToken);
      setFileName(data.fileName);
      setTotalRows(data.totalRows);
      setHeaders(data.headers);
      setFieldMapping(data.detectedMapping);
      setPreviewRows(data.previewRows);
      setValidCount(data.validCount);
      setErrorCount(data.errorCount);
      setValidationErrors(data.errors || []);
      setStep('mapping');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to upload file');
    } finally {
      setLoading(false);
    }
  };

  const handleMappingChange = (header: string, field: string) => {
    setFieldMapping((prev) => ({
      ...prev,
      [header]: field,
    }));
  };

  const handlePreview = async () => {
    if (!parseToken) return;
    setLoading(true);
    setError(null);

    try {
      const res = await api.post('/imports/preview', {
        parseToken,
        fieldMapping,
      });

      setValidCount(res.data.validCount);
      setErrorCount(res.data.errorCount);
      setValidationErrors(res.data.errors || []);
      setStep('confirm');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to validate data');
    } finally {
      setLoading(false);
    }
  };

  const handleAiMapping = async () => {
    if (!parseToken) return;
    setAiMappingLoading(true);
    setError(null);
    try {
      const res = await api.post('/imports/ai-mapping', { parseToken });
      setFieldMapping(res.data.fieldMapping || {});
      setValidCount(res.data.validCount || 0);
      setErrorCount(res.data.errorCount || 0);
      setValidationErrors(res.data.errors || []);
      setAiMappingNotes(res.data.notes || []);
    } catch (err: any) {
      setError(err.response?.data?.message || 'AI field recognition failed');
    } finally {
      setAiMappingLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!parseToken) return;
    setLoading(true);
    setError(null);

    try {
      const res = await api.post('/imports/confirm', {
        parseToken,
        fieldMapping,
      });

      setImportResult(res.data);
      setStep('report');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to execute import');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setStep('upload');
    setFile(null);
    setParseToken('');
    setFileName('');
    setTotalRows(0);
    setHeaders([]);
    setFieldMapping({});
    setPreviewRows([]);
    setValidCount(0);
    setErrorCount(0);
    setValidationErrors([]);
    setImportResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const getMappedField = (header: string): string => {
    return fieldMapping[header] || '';
  };

  const getMappedHeader = (field: string): string | null => {
    const entry = Object.entries(fieldMapping).find(([, f]) => f === field);
    return entry ? entry[0] : null;
  };

  const companyMapped = getMappedHeader('companyName');
  const emailMapped = getMappedHeader('contactEmail');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            Import Leads
          </h2>
          <p className="text-gray-500 dark:text-gray-400">
            Batch import leads from CSV or Excel files
          </p>
        </div>
        <Link
          href="/leads"
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Leads
        </Link>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4 text-sm text-red-600 dark:text-red-400 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Error</p>
            <p>{error}</p>
          </div>
        </div>
      )}

      {/* Step indicator */}
      <div className="flex items-center gap-2 text-sm">
        {(['upload', 'mapping', 'confirm', 'report'] as Step[]).map((s, i) => {
          const isActive = step === s;
          const isDone = (['upload', 'mapping', 'confirm', 'report'].indexOf(step) >
            ['upload', 'mapping', 'confirm', 'report'].indexOf(s));
          return (
            <div key={s} className="flex items-center gap-2">
              {i > 0 && <div className="w-8 h-px bg-gray-300 dark:bg-gray-700" />}
              <span
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                  isActive
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                    : isDone
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                }`}
              >
                {isDone ? <Check className="h-3 w-3" /> : null}
                {s === 'upload' ? 'Upload' : s === 'mapping' ? 'Mapping' : s === 'confirm' ? 'Confirm' : 'Report'}
              </span>
            </div>
          );
        })}
      </div>

      {/* Step 1: Upload */}
      {step === 'upload' && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6">
          <div className="max-w-xl mx-auto text-center">
            <Upload className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
              Upload File
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              Supports .csv and .xlsx files up to 5MB, max 1000 rows
            </p>
            <div className="flex items-center justify-center gap-4">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx"
                onChange={handleFileChange}
                className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 dark:file:bg-blue-900/20 dark:file:text-blue-400"
              />
            </div>
            {file && (
              <div className="mt-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-900/50 text-sm text-gray-600 dark:text-gray-400 flex items-center gap-2 justify-center">
                <FileText className="h-4 w-4" />
                {file.name} ({(file.size / 1024).toFixed(1)} KB)
              </div>
            )}
            <button
              onClick={handleUpload}
              disabled={!file || loading}
              className="mt-6 rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Parsing...' : 'Parse File'}
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Field Mapping */}
      {step === 'mapping' && (
        <div className="space-y-6">
          {/* Summary */}
          <div className="grid grid-cols-4 gap-4">
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-4 text-center">
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{totalRows}</p>
              <p className="text-xs text-gray-500">Total Rows</p>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-4 text-center">
              <p className="text-2xl font-bold text-green-600">{validCount}</p>
              <p className="text-xs text-gray-500">Valid</p>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-4 text-center">
              <p className="text-2xl font-bold text-red-600">{errorCount}</p>
              <p className="text-xs text-gray-500">Errors</p>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-4 text-center">
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{Object.keys(fieldMapping).length}</p>
              <p className="text-xs text-gray-500">Mapped Fields</p>
            </div>
          </div>

          {/* Field Mapping */}
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Field Mapping</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Map your file columns to Lead fields. <strong>Company Name</strong> is required.
                </p>
              </div>
              <button
                onClick={handleAiMapping}
                disabled={aiMappingLoading}
                className="inline-flex items-center gap-2 rounded-lg border border-purple-300 px-3 py-2 text-sm font-medium text-purple-700 hover:bg-purple-50 disabled:opacity-50 dark:border-purple-800 dark:text-purple-400 dark:hover:bg-purple-900/20"
              >
                {aiMappingLoading ? <Sparkles className="h-4 w-4 animate-pulse" /> : <Sparkles className="h-4 w-4" />}
                AI识别字段
              </button>
            </div>
            {aiMappingNotes.length > 0 && (
              <div className="mb-4 rounded-lg border border-purple-200 bg-purple-50 p-3 text-xs text-purple-700 dark:border-purple-800 dark:bg-purple-900/20 dark:text-purple-300">
                {aiMappingNotes.map((note, index) => <div key={index}>- {note}</div>)}
              </div>
            )}
            <div className="space-y-3">
              {headers.map((header) => (
                <div key={header} className="flex items-center gap-4">
                  <div className="w-1/3">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      {header}
                    </span>
                    {previewRows[0] && (
                      <p className="text-xs text-gray-400 truncate">{previewRows[0][header]}</p>
                    )}
                  </div>
                  <span className="text-gray-400">→</span>
                  <select
                    value={getMappedField(header)}
                    onChange={(e) => handleMappingChange(header, e.target.value)}
                    className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                  >
                    <option value="">-- Skip --</option>
                    {Object.entries(LEAD_FIELD_LABELS).map(([field, label]) => (
                      <option key={field} value={field}>{label}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>

          {/* Preview Table */}
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 overflow-hidden">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white px-6 pt-4">Data Preview</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
                    <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400 w-12">#</th>
                    {headers.map((h) => (
                      <th key={h} className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">
                        {h}
                        {getMappedField(h) && (
                          <span className="ml-1 text-xs text-blue-500">({getMappedField(h)})</span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.slice(0, 5).map((row, i) => (
                    <tr key={i} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                      <td className="px-4 py-2 text-gray-400">{i + 2}</td>
                      {headers.map((h) => (
                        <td key={h} className="px-4 py-2 text-gray-700 dark:text-gray-300 max-w-[200px] truncate">
                          {row[h]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalRows > 5 && (
              <p className="px-4 py-2 text-xs text-gray-400">Showing 5 of {totalRows} rows</p>
            )}
          </div>

          {/* Validation errors */}
          {validationErrors.length > 0 && (
            <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4">
              <h3 className="text-sm font-semibold text-red-700 dark:text-red-400 mb-2">
                Validation Errors ({validationErrors.length})
              </h3>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {validationErrors.slice(0, 20).map((err, i) => (
                  <p key={i} className="text-xs text-red-600 dark:text-red-400">
                    <strong>Row {err.row}:</strong> {err.field} — {err.message}
                  </p>
                ))}
                {validationErrors.length > 20 && (
                  <p className="text-xs text-red-400">...and {validationErrors.length - 20} more errors</p>
                )}
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleReset}
              className="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Back
            </button>
            <button
              onClick={handlePreview}
              disabled={loading || !companyMapped}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Validating...' : 'Validate & Continue'}
            </button>
            {!companyMapped && (
              <p className="text-xs text-amber-600 dark:text-amber-400 self-center">
                Please map Company Name field to continue
              </p>
            )}
          </div>
        </div>
      )}

      {/* Step 3: Confirm */}
      {step === 'confirm' && (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-4 text-center">
              <p className="text-3xl font-bold text-gray-900 dark:text-white">{totalRows}</p>
              <p className="text-xs text-gray-500">Total Rows</p>
            </div>
            <div className="rounded-xl border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-4 text-center">
              <p className="text-3xl font-bold text-green-600">{validCount}</p>
              <p className="text-xs text-green-500">Valid Rows (will be imported)</p>
            </div>
            <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 text-center">
              <p className="text-3xl font-bold text-red-600">{errorCount}</p>
              <p className="text-xs text-red-500">Error Rows (will be skipped)</p>
            </div>
          </div>

          {/* Mapped fields summary */}
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Field Mapping Summary</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {Object.entries(fieldMapping).map(([header, field]) => (
                <div key={header} className="flex items-center gap-2">
                  <span className="text-gray-500">{header}</span>
                  <span className="text-gray-400">→</span>
                  <span className="font-medium text-gray-700 dark:text-gray-300">
                    {LEAD_FIELD_LABELS[field] || field}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {validationErrors.length > 0 && (
            <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4">
              <h3 className="text-sm font-semibold text-red-700 dark:text-red-400 mb-2">
                Errors ({validationErrors.length}) — These rows will be skipped
              </h3>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {validationErrors.slice(0, 20).map((err, i) => (
                  <p key={i} className="text-xs text-red-600 dark:text-red-400">
                    <strong>Row {err.row}:</strong> {err.field} — {err.message}
                    {err.value && <span className="text-gray-400"> (value: {err.value})</span>}
                  </p>
                ))}
                {validationErrors.length > 20 && (
                  <p className="text-xs text-red-400">...and {validationErrors.length - 20} more errors</p>
                )}
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={() => setStep('mapping')}
              className="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Back to Mapping
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading || validCount === 0}
              className="rounded-lg bg-green-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Importing...' : `Import ${validCount} Leads`}
            </button>
            {validCount === 0 && (
              <p className="text-xs text-red-500 self-center">No valid rows to import</p>
            )}
          </div>
        </div>
      )}

      {/* Step 4: Report */}
      {step === 'report' && importResult && (
        <div className="space-y-6">
          <div className="rounded-xl border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-6 text-center">
            <Check className="h-12 w-12 text-green-500 mx-auto mb-2" />
            <h3 className="text-xl font-bold text-green-700 dark:text-green-400">Import Complete</h3>
            <p className="text-green-600 dark:text-green-500 mt-1">{importResult.fileName}</p>
          </div>

          <div className="grid grid-cols-4 gap-4">
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-4 text-center">
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{importResult.totalRows}</p>
              <p className="text-xs text-gray-500">Total Rows</p>
            </div>
            <div className="rounded-xl border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-4 text-center">
              <p className="text-2xl font-bold text-green-600">{importResult.successRows}</p>
              <p className="text-xs text-green-500">Imported</p>
            </div>
            <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 text-center">
              <p className="text-2xl font-bold text-red-600">{importResult.errorRows}</p>
              <p className="text-xs text-red-500">Errors</p>
            </div>
            <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 text-center">
              <p className="text-2xl font-bold text-amber-600">{importResult.duplicateRows}</p>
              <p className="text-xs text-amber-500">Duplicates Found</p>
            </div>
          </div>

          <div className="flex gap-3">
            <Link
              href="/leads"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
            >
              View Leads
            </Link>
            <Link
              href={`/imports/${importResult.importId}`}
              className="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              View Import Detail
            </Link>
            {importResult.duplicateRows > 0 && (
              <Link
                href="/duplicate-leads"
                className="rounded-lg border border-amber-300 dark:border-amber-700 px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20"
              >
                Review Duplicates
              </Link>
            )}
            <button
              onClick={handleReset}
              className="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Import More
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
