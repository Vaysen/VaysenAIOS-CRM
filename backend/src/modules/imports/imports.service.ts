import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DuplicateLeadsService } from '../duplicate-leads/duplicate-leads.service';
import { LeadScoresService } from '../lead-scores/lead-scores.service';
import { TimelineService } from '../timeline/timeline.service';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { completeAiJson } from '@/common/ai/ai-client.util';

const LEAD_FIELDS: { field: string; aliases: string[] }[] = [
  { field: 'companyName', aliases: ['company name', 'company', 'company_name', 'companyname', 'name', 'organization', 'business name'] },
  { field: 'website', aliases: ['website', 'web', 'url', 'site', 'web site', 'homepage'] },
  { field: 'websiteDomain', aliases: ['domain', 'website domain', 'website_domain', 'websitedomain'] },
  { field: 'country', aliases: ['country', 'nation'] },
  { field: 'city', aliases: ['city', 'town'] },
  { field: 'industry', aliases: ['industry', 'sector', 'field', 'vertical'] },
  { field: 'productCategory', aliases: ['product category', 'category', 'product_category', 'productcategory', 'product', 'products'] },
  { field: 'businessType', aliases: ['business type', 'business_type', 'businesstype', 'type', 'customer type'] },
  { field: 'contactName', aliases: ['contact name', 'contact', 'contact_name', 'contactname', 'contact person', 'person', 'full name'] },
  { field: 'contactTitle', aliases: ['title', 'job title', 'contact_title', 'contacttitle', 'position', 'designation', 'role'] },
  { field: 'contactEmail', aliases: ['email', 'contact email', 'contact_email', 'contactemail', 'e-mail', 'mail', 'email address'] },
  { field: 'contactPhone', aliases: ['phone', 'telephone', 'contact_phone', 'contact phone', 'contactphone', 'tel', 'phone number', 'mobile'] },
  { field: 'whatsapp', aliases: ['whatsapp', 'whats app', 'whats_app'] },
  { field: 'linkedinUrl', aliases: ['linkedin', 'linkedin url', 'linkedin_url', 'linkedinurl', 'linkedin profile'] },
  { field: 'facebookUrl', aliases: ['facebook', 'facebook url', 'facebook_url', 'facebookurl', 'fb'] },
  { field: 'sourceUrl', aliases: ['source url', 'source_url', 'sourceurl', 'source', 'source link', 'reference url'] },
  { field: 'sourceType', aliases: ['source type', 'source_type', 'sourcetype'] },
  { field: 'sourceKeyword', aliases: ['keyword', 'source keyword', 'source_keyword', 'sourcekeyword', 'search keyword', 'keywords'] },
  { field: 'sourceCountry', aliases: ['source country', 'source_country', 'sourcecountry'] },
  { field: 'confidenceScore', aliases: ['confidence', 'confidence score', 'confidence_score', 'confidencescore', 'score'] },
  { field: 'status', aliases: ['status', 'lead status', 'stage'] },
  { field: 'ownerUserId', aliases: ['owner', 'owner id', 'owner_user_id', 'owneruserid', 'assigned to'] },
  { field: 'notes', aliases: ['notes', 'note', 'description', 'comment', 'comments', 'remark'] },
  { field: 'isUncertain', aliases: ['is uncertain', 'is_uncertain', 'isuncertain', 'uncertain'] },
];

const VALID_STATUSES = [
  'new', 'contacted', 'replied', 'interested', 'quoted', 'won', 'lost',
];

const FREE_EMAIL_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com', 'pm.me',
  'zoho.com', 'yandex.com', 'mail.ru', 'inbox.ru', 'bk.ru', 'list.ru',
  '163.com', '126.com', 'qq.com', 'foxmail.com', 'sina.com', 'sohu.com',
  'yeah.net', 'aliyun.com',
];

@Injectable()
export class ImportsService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => DuplicateLeadsService))
    private duplicateLeadsService: DuplicateLeadsService,
    private leadScoresService: LeadScoresService,
    private timelineService: TimelineService,
  ) {}

  async upload(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.csv' && ext !== '.xlsx') {
      throw new BadRequestException('Only .csv and .xlsx files are supported');
    }

    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      throw new BadRequestException('File size exceeds 5MB limit');
    }

    if (file.size === 0) {
      throw new BadRequestException('File is empty');
    }

    let rows: Record<string, string>[];
    try {
      rows = this.parseFile(file);
    } catch (err: any) {
      throw new BadRequestException(`Failed to parse file: ${err.message}`);
    }

    if (rows.length === 0) {
      throw new BadRequestException('File contains no data rows');
    }

    const maxRows = 1000;
    if (rows.length > maxRows) {
      throw new BadRequestException(`File contains ${rows.length} rows. Maximum is ${maxRows} rows per import`);
    }

    const headers = Object.keys(rows[0]);
    const detectedMapping = this.autoDetectMapping(headers);

    // Validate with auto-detected mapping
    const validation = this.validateAllRows(rows, detectedMapping);

    // Save parsed data to temp file
    const parseToken = uuidv4();
    const tempDir = path.join(os.tmpdir(), 'vaysen-crm-imports');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempPath = path.join(tempDir, `${parseToken}.json`);
    fs.writeFileSync(tempPath, JSON.stringify({ rows, headers, originalName: file.originalname }));

    return {
      parseToken,
      fileName: file.originalname,
      fileSize: file.size,
      totalRows: rows.length,
      headers,
      detectedMapping,
      previewRows: rows.slice(0, 10),
      validCount: validation.validRows.length,
      errorCount: validation.errorRows.length,
      errors: validation.errorRows.slice(0, 20), // First 20 errors for preview
    };
  }

  async preview(parseToken: string, fieldMapping: Record<string, string>) {
    const data = this.readTempData(parseToken);
    if (!data) {
      throw new BadRequestException('Parse token expired or invalid. Please re-upload the file.');
    }

    const validation = this.validateAllRows(data.rows, fieldMapping);

    return {
      parseToken,
      fileName: data.originalName,
      totalRows: data.rows.length,
      headers: data.headers,
      fieldMapping,
      validCount: validation.validRows.length,
      errorCount: validation.errorRows.length,
      errors: validation.errorRows,
    };
  }

  async aiMapping(parseToken: string) {
    const data = this.readTempData(parseToken);
    if (!data) {
      throw new BadRequestException('Parse token expired or invalid. Please re-upload the file.');
    }

    const allowedFields = LEAD_FIELDS.map((item) => item.field);
    const prompt = `You help import messy CRM/customer files into this CRM.

Available CRM fields:
${allowedFields.join(', ')}

File headers:
${JSON.stringify(data.headers)}

Sample rows:
${JSON.stringify(data.rows.slice(0, 8), null, 2)}

Return strict JSON only:
{
  "mapping": { "Original Header": "crmField" },
  "confidence": 0,
  "notes": []
}

Rules:
- Map every clear customer/company/contact column.
- companyName is required. If a header means brand/company/store/organization/customer, map it to companyName.
- contactEmail must be a real email column, not social links.
- Use only fields from the available CRM fields list.
- Omit unknown or irrelevant headers from mapping.`;

    const response = await completeAiJson<any>({
      purpose: 'import',
      task: 'import',
      messages: [
        { role: 'system', content: 'Return strict JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.15,
      maxTokens: 1600,
    });

    const parsed = response.data || {};
    const rawMapping = parsed.mapping && typeof parsed.mapping === 'object' ? parsed.mapping : {};
    const mapping: Record<string, string> = {};
    for (const [header, field] of Object.entries(rawMapping)) {
      if (data.headers.includes(header) && allowedFields.includes(String(field))) {
        mapping[header] = String(field);
      }
    }

    const mergedMapping = {
      ...this.autoDetectMapping(data.headers),
      ...mapping,
    };
    const validation = this.validateAllRows(data.rows, mergedMapping);

    return {
      fieldMapping: mergedMapping,
      confidence: parsed.confidence || null,
      notes: parsed.notes || [],
      validCount: validation.validRows.length,
      errorCount: validation.errorRows.length,
      errors: validation.errorRows.slice(0, 20),
    };
  }

  async confirm(parseToken: string, fieldMapping: Record<string, string>, currentUser: any) {
    const data = this.readTempData(parseToken);
    if (!data) {
      throw new BadRequestException('Parse token expired or invalid. Please re-upload the file.');
    }

    const companyId = currentUser.companies[0]?.id;
    if (!companyId) {
      throw new ForbiddenException('No company associated');
    }

    this.checkWriteAccess(currentUser, companyId);

    const isSalesUser = this.isSalesUserOnly(currentUser);
    const defaultOwnerUserId = isSalesUser ? currentUser.id : null;

    const validation = this.validateAllRows(data.rows, fieldMapping);

    const importTask = await this.prisma.importTask.create({
      data: {
        companyId,
        createdBy: currentUser.id,
        fileName: data.originalName,
        fileSize: data.rows.length,
        totalRows: data.rows.length,
        successRows: 0,
        skippedRows: 0,
        errorRows: validation.errorRows.length,
        duplicateRows: 0,
        fieldMapping,
        status: 'processing',
        startedAt: new Date(),
      },
    });

    // Save import errors
    if (validation.errorRows.length > 0) {
      await this.prisma.importError.createMany({
        data: validation.errorRows.map((e) => ({
          importTaskId: importTask.id,
          rowNumber: e.row,
          fieldName: e.field,
          errorType: 'validation',
          errorMessage: e.message,
          rawValue: e.value,
        })),
      });
    }

    let successCount = 0;
    let skipCount = 0;
    let duplicateCount = 0;

    // Process valid rows
    for (const row of validation.validRows) {
      try {
        const leadData = this.mapRowToLead(row, fieldMapping);
        if (!leadData.companyName || !leadData.companyName.trim()) {
          skipCount++;
          await this.prisma.importError.create({
            data: {
              importTaskId: importTask.id,
              rowNumber: row.__row,
              fieldName: 'companyName',
              errorType: 'validation',
              errorMessage: 'Company name is required',
              rawValue: leadData.companyName || '',
            },
          });
          continue;
        }

        // Extract domain from website
        if (leadData.website && !leadData.websiteDomain) {
          leadData.websiteDomain = this.extractDomain(leadData.website);
        }

        // Default owner for sales user
        if (!leadData.ownerUserId && defaultOwnerUserId) {
          leadData.ownerUserId = defaultOwnerUserId;
        }

        // Validate email format
        if (leadData.contactEmail && !this.isValidEmail(leadData.contactEmail)) {
          skipCount++;
          await this.prisma.importError.create({
            data: {
              importTaskId: importTask.id,
              rowNumber: row.__row,
              fieldName: 'contactEmail',
              errorType: 'validation',
              errorMessage: `Invalid email format: ${leadData.contactEmail}`,
              rawValue: leadData.contactEmail,
            },
          });
          continue;
        }

        // Validate status
        if (leadData.status && !VALID_STATUSES.includes(leadData.status)) {
          leadData.status = 'new';
        }

        const lead = await this.prisma.lead.create({
          data: {
            ...leadData,
            companyId,
            sourceType: leadData.sourceType || 'import',
          },
        });

        // Activity record
        await this.timelineService.logActivity({
          companyId,
          leadId: lead.id,
          userId: currentUser.id,
          activityType: 'imported',
          title: '导入了客户',
          description: `从 ${data.originalName} 导入了客户 "${lead.companyName}"`,
        });

        // Auto duplicate detection
        try {
          const dupResult = await this.duplicateLeadsService.detectDuplicates(lead, currentUser);
          if (dupResult.hasDuplicates) {
            duplicateCount++;
          }
        } catch {
          // Silently ignore
        }

        // Auto score
        try {
          const scoreResult = await this.leadScoresService.calculateAndSave(lead.id, currentUser);
          await this.prisma.lead.update({
            where: { id: lead.id },
            data: { leadScore: scoreResult.totalScore, leadGrade: scoreResult.grade },
          });
        } catch {
          // Silently ignore
        }

        successCount++;
      } catch (err: any) {
        skipCount++;
        await this.prisma.importError.create({
          data: {
            importTaskId: importTask.id,
            rowNumber: row.__row,
            fieldName: '',
            errorType: 'system',
            errorMessage: err.message || 'Unknown error',
            rawValue: '',
          },
        });
      }
    }

    const finalErrorCount = validation.errorRows.length + skipCount - (validation.validRows.length - successCount);
    // Recalculate: errorRows from validation + any skips during processing
    const totalErrors = await this.prisma.importError.count({ where: { importTaskId: importTask.id } });

    await this.prisma.importTask.update({
      where: { id: importTask.id },
      data: {
        successRows: successCount,
        errorRows: totalErrors,
        duplicateRows: duplicateCount,
        status: 'completed',
        completedAt: new Date(),
      },
    });

    // Clean up temp file
    this.deleteTempData(parseToken);

    return {
      importId: importTask.id,
      fileName: data.originalName,
      totalRows: data.rows.length,
      successRows: successCount,
      errorRows: totalErrors,
      duplicateRows: duplicateCount,
      status: 'completed',
    };
  }

  async findAll(currentUser: any, query: { page?: number; limit?: number }) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const companyIds = currentUser.companies?.map((c: any) => c.id) || [];
    const isFullAccess = currentUser.companies?.some(
      (c: any) => ['super_admin', 'company_admin'].includes(c.role),
    );

    const where: any = { companyId: { in: companyIds } };
    if (!isFullAccess) {
      where.createdBy = currentUser.id;
    }

    const [data, total] = await Promise.all([
      this.prisma.importTask.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.importTask.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, currentUser: any) {
    const task = await this.prisma.importTask.findUnique({ where: { id } });
    if (!task) {
      throw new NotFoundException('Import task not found');
    }

    const companyIds = currentUser.companies?.map((c: any) => c.id) || [];
    if (!companyIds.includes(task.companyId)) {
      throw new ForbiddenException('Cannot access imports from another company');
    }

    // Sub-account isolation: non-admin can only access own imports
    const isFullAccess = currentUser.companies?.some(
      (c: any) => ['super_admin', 'company_admin'].includes(c.role),
    );
    if (!isFullAccess && task.createdBy !== currentUser.id) {
      throw new ForbiddenException('You can only access your own imports');
    }

    return task;
  }

  async getErrors(id: string, currentUser: any) {
    const task = await this.findOne(id, currentUser);
    const errors = await this.prisma.importError.findMany({
      where: { importTaskId: id },
      orderBy: { rowNumber: 'asc' },
    });
    return { data: errors, total: errors.length };
  }

  async downloadErrors(id: string, currentUser: any): Promise<{ content: string; fileName: string }> {
    const task = await this.findOne(id, currentUser);
    if (!task) {
      throw new NotFoundException('Import task not found');
    }

    const errors = await this.prisma.importError.findMany({
      where: { importTaskId: id },
      orderBy: { rowNumber: 'asc' },
    });

    const headers = ['Row', 'Field', 'Error Type', 'Error Message', 'Raw Value'];
    const rows = errors.map((e) =>
      [e.rowNumber, e.fieldName, e.errorType, e.errorMessage, e.rawValue || '']
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );

    const content = [headers.join(','), ...rows].join('\n');
    const fileName = `import-errors-${task.fileName.replace(path.extname(task.fileName), '')}.csv`;

    return { content, fileName };
  }

  // --- Private helpers ---

  private parseFile(file: Express.Multer.File): Record<string, string>[] {
    const ext = path.extname(file.originalname).toLowerCase();
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new Error('No sheet found in file');
    }
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '' });
    return jsonData;
  }

  private autoDetectMapping(headers: string[]): Record<string, string> {
    const mapping: Record<string, string> = {};

    for (const header of headers) {
      const normalizedHeader = header.trim().toLowerCase();
      for (const field of LEAD_FIELDS) {
        if (field.aliases.some((alias) => normalizedHeader === alias)) {
          mapping[header] = field.field;
          break;
        }
      }
    }

    return mapping;
  }

  private validateAllRows(
    rows: Record<string, string>[],
    fieldMapping: Record<string, string>,
  ): { validRows: Record<string, any>[]; errorRows: any[] } {
    const validRows: Record<string, any>[] = [];
    const errorRows: any[] = [];

    // Determine which field maps to companyName
    const companyNameHeader = Object.entries(fieldMapping).find(
      ([_, field]) => field === 'companyName',
    )?.[0];

    rows.forEach((row, index) => {
      const rowNum = index + 2; // 1-indexed, +1 for header
      const mappedRow: Record<string, any> = { ...row, __row: rowNum };
      let hasError = false;

      // Required field check: companyName
      if (companyNameHeader) {
        const companyNameValue = row[companyNameHeader];
        if (!companyNameValue || !companyNameValue.trim()) {
          errorRows.push({
            row: rowNum,
            field: 'companyName',
            message: 'Company name is required',
            value: companyNameValue || '',
          });
          hasError = true;
        }
      } else {
        errorRows.push({
          row: rowNum,
          field: 'companyName',
          message: 'Company name field is not mapped',
          value: '',
        });
        hasError = true;
      }

      // Email validation
      const emailHeader = Object.entries(fieldMapping).find(
        ([_, field]) => field === 'contactEmail',
      )?.[0];
      if (emailHeader) {
        const emailValue = row[emailHeader];
        if (emailValue && emailValue.trim() && !this.isValidEmail(emailValue.trim())) {
          errorRows.push({
            row: rowNum,
            field: 'contactEmail',
            message: `Invalid email format: ${emailValue}`,
            value: emailValue,
          });
          hasError = true;
        }
      }

      if (!hasError) {
        validRows.push(mappedRow);
      }
    });

    return { validRows, errorRows };
  }

  private mapRowToLead(row: Record<string, string>, fieldMapping: Record<string, string>): any {
    const leadData: any = {};

    for (const [header, field] of Object.entries(fieldMapping)) {
      const value = row[header];
      if (value === undefined || value === null || value === '') continue;

      switch (field) {
        case 'confidenceScore':
        case 'leadScore':
          leadData[field] = parseInt(value, 10) || null;
          break;
        case 'isUncertain':
          leadData[field] = ['true', 'yes', '1', 'y'].includes(value.toLowerCase().trim());
          break;
        default:
          leadData[field] = value.trim();
      }
    }

    return leadData;
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private extractDomain(url: string): string {
    try {
      const u = new URL(url.startsWith('http') ? url : `https://${url}`);
      return u.hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  private readTempData(parseToken: string): { rows: Record<string, string>[]; headers: string[]; originalName: string } | null {
    try {
      const tempPath = path.join(os.tmpdir(), 'vaysen-crm-imports', `${parseToken}.json`);
      if (!fs.existsSync(tempPath)) return null;
      const content = fs.readFileSync(tempPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private parseJsonObject(content: string): any {
    const clean = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try {
      const parsed = JSON.parse(clean);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) return {};
      try {
        const parsed = JSON.parse(match[0]);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
  }

  private deleteTempData(parseToken: string): void {
    try {
      const tempPath = path.join(os.tmpdir(), 'vaysen-crm-imports', `${parseToken}.json`);
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Silently ignore cleanup errors
    }
  }

  private checkWriteAccess(currentUser: any, companyId: string) {
    const isSuperAdmin = currentUser.companies?.some(
      (c: any) => c.role === 'super_admin',
    );
    if (isSuperAdmin) return;

    const company = currentUser.companies?.find((c: any) => c.id === companyId);
    if (!company) {
      throw new ForbiddenException('Not a member of this company');
    }

    const allowedRoles = ['company_admin', 'sales_manager', 'sales_user'];
    if (!allowedRoles.includes(company.role)) {
      throw new ForbiddenException('Viewer cannot modify leads');
    }
  }

  private isSalesUserOnly(currentUser: any): boolean {
    const roles = currentUser.companies?.map((c: any) => c.role) || [];
    return roles.length > 0 && roles.every((r: string) => r === 'sales_user' || r === 'viewer')
      && roles.some((r: string) => r === 'sales_user');
  }
}
