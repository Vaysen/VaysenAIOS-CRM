import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { completeAiJson } from '@/common/ai/ai-client.util';
import { v4 as uuid } from 'uuid';
import { randomCategoryAcrossAllLayers, formatTaskTitle, ALL_LAYERS, randomTargetCountry } from '../search/prospect-categories';
import * as dns from 'dns/promises';
import { isLegacyBusinessText, productFocusKeywords, resolveBusinessContext } from '@/common/business-context';

type EvidenceProspect = {
  title: string;
  url: string;
  website?: string;
  snippet: string;
  whyTarget?: string;
  companyName: string;
  contactEmail: string;
  contactPhone: string;
  contactPerson: string;
  contactTitle: string;
  emailSource: string;
  emailConfidence: string;
  industryCategory: string;
  confidenceScore: number;
  mainProducts: string;
  hasEmail: boolean;
  source: string;
  pipelineStage: 'ready_for_outreach' | 'manual_review' | 'rejected';
  verificationStatus: string;
  rejectionReasons: string[];
  evidenceSources: any[];
  fieldConfidence: Record<string, any>;
  linkedin?: string;
  facebook?: string;
  instagram?: string;
  twitter?: string;
  whatsapp?: string;
};

interface ProspectProfile {
  _layerId?: number;
  _categoryName?: string;
  keywords: string[];
  targetCountry: string;
  customerType?: string;
  excludeWords?: string[];
  maxResults: number;
}

@Injectable()
export class ContinuousProspectService {
  private readonly logger = new Logger(ContinuousProspectService.name);
  private running = false;
  private paused = false;
  private currentCycle = 0;
  private totalFound = 0;
  private cycleStartMs = 0;
  private lastError = '';

  // Configurable intervals
  private readonly CYCLE_INTERVAL_MS = 60_000; // 1 min between cycles
  private readonly PAUSE_CHECK_MS = 5_000;
  private readonly TARGET_PER_CYCLE = 50;

  constructor(private readonly prisma: PrismaService) {}

  getStatus() {
    return {
      running: this.running,
      paused: this.paused,
      currentCycle: this.currentCycle,
      totalFound: this.totalFound,
      cycleElapsedMs: this.cycleStartMs ? Date.now() - this.cycleStartMs : 0,
      lastError: this.lastError || null,
    };
  }

  async start() {
    if (this.running) return { message: 'Already running', ...this.getStatus() };
    this.running = true;
    this.paused = false;
    this.currentCycle = 0;
    this.totalFound = 0;
    this.lastError = '';
    this.logger.log('Continuous prospect worker started');
    // Run in background
    this.runLoop().catch((err) => {
      this.logger.error(`Continuous prospect loop crashed: ${err.message}`);
      this.lastError = err.message;
      this.running = false;
    });
    return { message: 'Started', ...this.getStatus() };
  }

  async pause() {
    this.paused = true;
    this.logger.log('Continuous prospect worker paused');
    return { message: 'Paused', ...this.getStatus() };
  }

  async resume() {
    this.paused = false;
    this.logger.log('Continuous prospect worker resumed');
    return { message: 'Resumed', ...this.getStatus() };
  }

  async stop() {
    this.running = false;
    this.paused = false;
    this.logger.log('Continuous prospect worker stopped');
    return { message: 'Stopped', ...this.getStatus() };
  }

  private normalizeText(value: any): string | undefined {
    if (Array.isArray(value)) {
      const text = value.map((item) => String(item || '').trim()).filter(Boolean).join(', ');
      return text || undefined;
    }
    const text = String(value || '').trim();
    return text || undefined;
  }

  private async runLoop() {
    while (this.running) {
      // Wait if paused
      while (this.paused && this.running) {
        await this.sleep(this.PAUSE_CHECK_MS);
      }
      if (!this.running) break;

      this.currentCycle++;
      this.cycleStartMs = Date.now();
      this.logger.log(`=== Cycle ${this.currentCycle} starting ===`);

      try {
        const companies = await this.prisma.company.findMany({
          where: { isActive: true },
          select: { id: true, name: true, settings: true },
        });

        for (const company of companies) {
          if (!this.running || this.paused) break;

          const companySettings = company.settings as any;
          const business = resolveBusinessContext(process.env, companySettings);
          const profiles = this.extractProfiles(companySettings);
          if (!profiles.length) {
            // Pick a random category across all 5 layers for 7x24 rotation.
            // Country is orthogonal to category: rotate across tiered target
            // markets (weighted to tier 1) instead of always using USA.
            const { layer, category } = randomCategoryAcrossAllLayers();
            const rotatedCountry = randomTargetCountry();
            this.logger.log(`Cycle ${this.currentCycle}: using Layer ${layer.id} - ${category.name} - ${rotatedCountry}`);
            profiles.push({
              keywords: Array.from(new Set([
                ...productFocusKeywords(business.productFocus),
                ...category.keywords,
              ])).slice(0, 8),
              targetCountry: rotatedCountry,
              customerType: `${category.customerType} Business focus: ${business.targetCustomerProfile}`,
              excludeWords: category.excludeWords || [],
              maxResults: this.TARGET_PER_CYCLE,
              _layerId: layer.id,
              _categoryName: category.name,
            });
          }

          for (const profile of profiles) {
            if (!this.running || this.paused) break;

            try {
              const found = await this.executeProspectCycle(
                company.id,
                company.name,
                profile,
              );
              this.totalFound += found;
              this.logger.log(
                `Company ${company.name}: cycle found ${found} prospects (total: ${this.totalFound})`,
              );
            } catch (err: any) {
              this.logger.error(
                `Prospect cycle failed for ${company.name}: ${err.message}`,
              );
            }
          }
        }
      } catch (err: any) {
        this.logger.error(`Cycle ${this.currentCycle} failed: ${err.message}`);
        this.lastError = err.message;
      }

      this.logger.log(
        `=== Cycle ${this.currentCycle} complete: ${this.totalFound} total prospects ===`,
      );

      // Wait before next cycle
      if (this.running) {
        await this.sleep(this.CYCLE_INTERVAL_MS);
      }
    }
    this.logger.log('Continuous prospect loop exited');
  }

  private extractProfiles(settings: any): ProspectProfile[] {
    const business = resolveBusinessContext(process.env, settings);
    if (!settings) return [];
    const profiles: ProspectProfile[] = [];

    // Support array of profiles
    if (Array.isArray(settings.prospectProfiles)) {
      return settings.prospectProfiles.map((p: any) => {
        const configuredKeywords = (Array.isArray(p.keywords) ? p.keywords : [p.keywords])
          .map((keyword: unknown) => String(keyword || '').trim())
          .filter((keyword: string) => keyword && !isLegacyBusinessText(keyword));
        const configuredCustomerType = this.normalizeText(p.customerType);
        return {
          keywords: configuredKeywords.length ? configuredKeywords : productFocusKeywords(business.productFocus),
          targetCountry: p.targetCountry || 'USA',
          customerType: configuredCustomerType && !isLegacyBusinessText(configuredCustomerType)
            ? configuredCustomerType
            : business.targetCustomerProfile,
          excludeWords: p.excludeWords || [],
          maxResults: p.maxResults || this.TARGET_PER_CYCLE,
        };
      });
    }

    // Legacy single profile
    const keywords = settings.defaultProspectKeywords ||
      settings.prospectKeywords ||
      (settings.defaultProductFocus ? [settings.defaultProductFocus] : null);

    if (keywords) {
      const configuredKeywords = (Array.isArray(keywords) ? keywords : [keywords])
        .map((keyword: unknown) => String(keyword || '').trim())
        .filter((keyword: string) => keyword && !isLegacyBusinessText(keyword));
      profiles.push({
        keywords: configuredKeywords.length ? configuredKeywords : productFocusKeywords(business.productFocus),
        targetCountry: settings.defaultTargetCountry || 'USA',
        customerType: business.targetCustomerProfile,
        excludeWords: [],
        maxResults: this.TARGET_PER_CYCLE,
      });
    }

    return profiles;
  }

  private async executeProspectCycle(
    companyId: string,
    companyName: string,
    profile: ProspectProfile,
  ): Promise<number> {
    // Create a search task record
    const task = await this.prisma.searchTask.create({
      data: {
        companyId,
        createdBy: 'continuous-worker',
        keywords: profile.keywords,
        targetCountry: profile.targetCountry,
        customerType: profile.customerType || null,
        excludeWords: profile.excludeWords || [],
        maxResults: profile.maxResults,
        status: 'running',
        startedAt: new Date(),
      },
    });

    this.logger.log(`Searching with keywords: ${profile.keywords.slice(0,2).join(", ")}`);
    const seenDomains = new Set<string>();
    let totalSaved = 0;
    const MAX_BATCHES = Math.ceil(profile.maxResults / 10) + 5;
    const BATCH_SIZE = 10;

    try {
      for (let batch = 0; batch < MAX_BATCHES && totalSaved < profile.maxResults; batch++) {
        this.logger.log(`Batch ${batch}: searching...`);
        const candidates = await this.searchWeb(profile, BATCH_SIZE);
        this.logger.log(`Batch ${batch}: found ${candidates.length} candidates`);

        for (const candidate of candidates) {
          if (totalSaved >= profile.maxResults) break;

          const domain = this.extractDomain(candidate.url);
          if (!domain || seenDomains.has(domain)) continue;
          seenDomains.add(domain);

          this.logger.log(`Evaluating: ${candidate.title?.substring(0,40) || candidate.url}`);
          const prospect = await this.evaluateProspect(candidate, profile, companyName);
          if (prospect) this.logger.log(`-> ${prospect.pipelineStage} email=${prospect.contactEmail || "none"}`);
          if (!prospect || prospect.pipelineStage === 'rejected') continue;

          // Save to search results
          await this.prisma.searchResult.create({
            data: {
              searchTaskId: task.id,
              title: prospect.title || prospect.companyName || candidate.title || 'Untitled',
              url: prospect.url || prospect.website || '',
              snippet: prospect.snippet || '',
              source: 'continuous-prospect',
              keyword: profile.keywords[0],
              country: profile.targetCountry,
              hasEmail: !!prospect.contactEmail,
              aiAnalysis: prospect as any,
              status: prospect.pipelineStage,
            },
          });

          totalSaved++;

          // Only evidence-ready prospects enter lead records automatically.
          // Manual-review prospects stay out of the mailing flow until a user approves them.
          if (prospect.pipelineStage === 'ready_for_outreach' && prospect.contactEmail) {
            await this.autoConvertToLead(companyId, prospect);
          }
        }

        this.logger.log(
          `Batch ${batch + 1}/${MAX_BATCHES}: ${totalSaved}/${profile.maxResults} saved`,
        );
      }
    } finally {
      await this.prisma.searchTask.update({
        where: { id: task.id },
        data: { status: 'completed', totalFound: totalSaved, completedAt: new Date() },
      });
    }

    return totalSaved;
  }

  private async autoConvertToLead(companyId: string, prospect: EvidenceProspect) {
    try {
      const domain = this.extractDomain(prospect.url || prospect.website || '');

      // Check for existing lead by email or domain
      const existing = await this.prisma.lead.findFirst({
        where: {
          companyId,
          OR: [
            { contactEmail: prospect.contactEmail },
            { websiteDomain: domain },
          ].filter(Boolean),
        },
      });

      if (existing) return; // Already exists

      // Lead goes to assignment center UNASSIGNED — only admin can distribute
      const lead = await this.prisma.lead.create({
        data: {
          companyId,
          companyName: prospect.companyName || prospect.title,
          website: prospect.url || prospect.website,
          websiteDomain: domain,
          country: (prospect as any).targetCountry || '',
          industry: prospect.industryCategory,
          contactName: prospect.contactPerson || '',
          contactTitle: prospect.contactTitle || '',
          contactEmail: prospect.contactEmail || '',
          contactPhone: prospect.contactPhone || '',
          linkedinUrl: prospect.linkedin || '',
          facebookUrl: prospect.facebook || '',
          instagramUrl: prospect.instagram || '',
          twitterUrl: prospect.twitter || '',
          whatsapp: prospect.whatsapp || '',
          mainProducts: prospect.mainProducts || '',
          sourceType: 'continuous-prospect',
          sourceUrl: prospect.url,
          status: 'new',
          reviewStatus: 'pending',
          leadGrade: prospect.contactEmail ? 'B' : 'C',
          confidenceScore: prospect.confidenceScore || 50,
          collectedAt: new Date(),
          // Priority for email + social contacts
          notes: prospect.contactEmail && (prospect.whatsapp || prospect.linkedin)
            ? 'Priority: has email + social contact'
            : '',
        },
      });

      this.logger.log(`Auto-converted lead: ${lead.companyName} (${lead.contactEmail})`);
    } catch (err: any) {
      // Don't let one failed conversion stop the cycle
      this.logger.warn(`Auto-convert failed: ${err.message}`);
    }
  }

  private async searchWeb(
    profile: ProspectProfile,
    batchSize: number,
  ): Promise<Array<{ title: string; url: string; snippet: string }>> {
    // Broad keyword-only queries (no country, no quotes) — SearXNG works better this way
    const kw = profile.keywords.join(' ');
    const queries = [
      `${kw} manufacturer supplier`,
      `${kw} company contact`,
      `${kw} distributor wholesale`,
      `${kw} brand`,
    ].filter((q) => q.length > 5);

    const allCandidates: Array<{ title: string; url: string; snippet: string }> = [];
    const seenUrls = new Set<string>();

    for (const query of queries) {
      try {
        const base = process.env.SEARXNG_URL || process.env.SEARXNG_BASE_URL || 'http://127.0.0.1:8080';
        const url = `${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json&language=en`;
        const resp = await Promise.race([
          fetch(url, {
          headers: { 'User-Agent': 'Vaysen AI CRM/2.0' },
          signal: AbortSignal.timeout(10000),
          }),
          new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('SearXNG timeout')), 15000)),
        ]) as Response;
        if (!resp.ok) continue;
        const data = await resp.json();
        const rows = Array.isArray(data.results) ? data.results : [];
        for (const item of rows) {
          const itemUrl = item.url || '';
          if (!itemUrl || !/^https?:\/\//i.test(itemUrl)) continue;
          if (seenUrls.has(itemUrl)) continue;
          seenUrls.add(itemUrl);
          allCandidates.push({
            title: String(item.title || '').replace(/<[^>]*>/g, ''),
            url: itemUrl,
            snippet: String(item.content || item.snippet || '').replace(/<[^>]*>/g, ''),
          });
        }
      } catch {
        // SearXNG failed, skip this query
      }

      if (allCandidates.length >= batchSize * 3) break;
    }

    return allCandidates.slice(0, batchSize * 3);
  }

  /** Evidence-first evaluation: crawl website, extract real data, then classify with AI if warranted. */
  private async evaluateProspect(
    candidate: { title: string; url: string; snippet: string },
    profile: ProspectProfile,
    companyName: string,
  ): Promise<EvidenceProspect | null> {
    const business = resolveBusinessContext();
    try {
      const domain = this.extractDomain(candidate.url);
      if (!domain) return null;
      if (!candidate.title) candidate.title = domain;

      // Step 1: Crawl website for real evidence
      const pages = await this.fetchCandidatePages(candidate.url);
      const pageText = pages.join('\n');

      // Step 2: Extract real emails, phones, social from page content (no AI)
      const emails = this.extractEmails(pages);
      const bestEmail = this.pickBestEmail(emails);
      const phone = this.extractPhone(pages);
      const social = this.extractSocial(pages);

      // Step 3: Pipeline stage from evidence
      const rejectionReasons: string[] = [];
      if (!bestEmail) rejectionReasons.push('No business email found on website');
      else if (this.isRoleEmail(bestEmail)) rejectionReasons.push('Role-based email only: ' + bestEmail);
      else if (this.isFreeEmail(bestEmail)) rejectionReasons.push('Free email provider: ' + bestEmail);
      if (pageText.length < 100) rejectionReasons.push('Website pages could not be crawled');

      let pipelineStage = 'rejected';
      if (bestEmail && rejectionReasons.length <= 1 && !this.isRoleEmail(bestEmail) && !this.isFreeEmail(bestEmail)) {
        pipelineStage = 'ready_for_outreach';
      } else if (bestEmail && rejectionReasons.length <= 2) {
        pipelineStage = 'manual_review';
      }

      // Step 4: Build result from real evidence
      const prospect: EvidenceProspect = {
        title: candidate.title,
        url: candidate.url,
        snippet: pageText.slice(0, 300) || candidate.snippet || '',
        companyName: candidate.title,
        contactEmail: bestEmail || '',
        contactPhone: phone || '',
        contactPerson: '',
        contactTitle: '',
        emailSource: bestEmail ? 'website-crawl' : '',
        emailConfidence: !bestEmail ? 'None' : this.isRoleEmail(bestEmail) ? 'Low' : 'Medium',
        industryCategory: profile.customerType || '',
        confidenceScore: bestEmail ? (this.isRoleEmail(bestEmail) ? 45 : 65) : 10,
        mainProducts: '',
        hasEmail: !!bestEmail,
        source: 'evidence-first-crawl',
        pipelineStage: pipelineStage as any,
        verificationStatus: bestEmail ? 'public_page_verified' : 'rejected',
        rejectionReasons,
        evidenceSources: pages.map((p, i) => ({ type: 'crawled_page', url: candidate.url + (i > 0 ? '/page' + i : ''), excerpt: p.slice(0, 200) })),
        fieldConfidence: { email: bestEmail ? 'High' : 'None' },
        linkedin: social.linkedin || '',
        facebook: social.facebook || '',
        instagram: social.instagram || '',
        twitter: social.twitter || '',
      };

      // Step 5: AI classification only if we have real evidence
      if (bestEmail && pageText.length > 200 && pipelineStage !== 'rejected') {
        try {
          const ai = await completeAiJson({
            purpose: 'prospect',
            task: 'profile',
            messages: [
              {
                role: 'system',
                content: `${business.brandName} sells ${business.productFocus}. Its target buyers are ${business.targetCustomerProfile}. Candidate: ${candidate.title}. Found email: ${bestEmail}. Phone: ${phone || 'none'}. Social: ${JSON.stringify(social)}. Determine from public evidence whether this company fits the selected buyer profile: ${profile.customerType || business.targetCustomerProfile}. Return JSON: {industryCategory: string, mainProducts: string, confidenceScore: number, isGoodFit: bool, reason: string}. Only mark isGoodFit=false if clearly not a match. Never invent facts.`,
              },
              { role: 'user', content: pageText.slice(0, 1500) },
            ],
            temperature: 0.2,
            maxTokens: 400,
          });
          if (ai?.data) {
            prospect.industryCategory = ai.data.industryCategory || prospect.industryCategory;
            prospect.mainProducts = ai.data.mainProducts || '';
            prospect.confidenceScore = ai.data.confidenceScore || prospect.confidenceScore;
            if (ai.data.isGoodFit === false && pipelineStage === 'ready_for_outreach') {
              prospect.pipelineStage = 'manual_review';
              prospect.rejectionReasons.push('AI: ' + (ai.data.reason || 'not a fit'));
            }
          }
        } catch { /* AI failed, keep evidence-only result */ }
      }

      return prospect;
    } catch {
      return null;
    }
  }

  // === Evidence Collection Helpers ===

  private async fetchCandidatePages(url: string): Promise<string[]> {
    const base = new URL(url.startsWith('http') ? url : `https://${url}`);
    const paths = ['', '/contact', '/about', '/about-us', '/contact-us'];
    const pages: string[] = [];
    for (const path of paths) {
      try {
        const target = `${base.protocol}//${base.host}${path}`;
        const html = await this.fetchText(target);
        if (html && html.length > 80) {
          const text = this.stripHtml(html).replace(/\s+/g, ' ').trim();
          if (text.length > 80) pages.push(text);
        }
      } catch { /* skip */ }
      if (pages.join('\n').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) && pages.length >= 2) break;
    }
    return pages;
  }

  private extractEmails(pages: string[]): string[] {
    const seen = new Set<string>();
    const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}\b/gi;
    const found: string[] = [];
    for (const page of pages) {
      for (const email of page.match(re) || []) {
        const e = this.normalizeEvidenceEmail(email);
        if (!e) continue;
        if (seen.has(e)) continue;
        seen.add(e);
        found.push(e);
      }
    }
    return found;
  }

  private normalizeEvidenceEmail(value: string): string | null {
    const e = String(value || '').trim().toLowerCase().replace(/[),.;:!?]+$/g, '');
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(e)) return null;
    if (/example\.|sentry\.|wixpress\.|schema\.org|test@|your-domain|your@email|user@domain|verify@|noreply@|donotreply@|no-reply@|placeholder/i.test(e)) return null;
    if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|json|xml|pdf|ico|woff|ttf)$/i.test(e)) return null;
    if (/@\d+x\d+/.test(e) || /@x\d+/.test(e)) return null;

    const [localPart, domain] = e.split('@');
    if (!localPart || !domain || localPart.length < 2 || domain.length < 4 || !domain.includes('.')) return null;
    if (domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) return null;
    const tld = domain.split('.').pop() || '';
    const invalidJoinedTlds = new Set([
      'combook', 'comcontact', 'comprivacy', 'comterms', 'comabout', 'comshop', 'comcart', 'comaccount',
      'comphone', 'comcustomer', 'comopening', 'comgeneral', 'comtelephone', 'comresponse', 'comstage',
      'netphone', 'orgphone', 'cophone', 'euphone', 'dephone', 'ukphone',
    ]);
    const commonTldPrefix = /^(com|net|org|co|eu|de|uk|us|ca|au|jp|fr|it|es|nl|se|no|dk|ch|at|io|ai|info|biz)[a-z]{2,}$/i;
    if (invalidJoinedTlds.has(tld) || commonTldPrefix.test(tld)) return null;
    return e;
  }

  private pickBestEmail(emails: string[]): string | null {
    if (!emails.length) return null;
    return emails.sort((a, b) => {
      const scoreA = (this.isRoleEmail(a) ? -10 : 0) + (this.isFreeEmail(a) ? -5 : 0);
      const scoreB = (this.isRoleEmail(b) ? -10 : 0) + (this.isFreeEmail(b) ? -5 : 0);
      return scoreB - scoreA;
    })[0];
  }

  private extractPhone(pages: string[]): string | null {
    const re = /(?:\+?[1-9]\d{0,2}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
    for (const page of pages) {
      const m = page.match(re);
      if (m) return m[0];
    }
    return null;
  }

  private extractSocial(pages: string[]): Record<string, string> {
    const r: Record<string, string> = {};
    const c = pages.join(' ');
    const patterns: [string, RegExp][] = [
      ['linkedin', /https?:\/\/(?:www\.)?linkedin\.com\/[^\s"'<>]+/i],
      ['facebook', /https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]+/i],
      ['instagram', /https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>]+/i],
      ['twitter', /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^\s"'<>]+/i],
    ];
    for (const [k, re] of patterns) { const m = c.match(re); if (m) r[k] = m[0]; }
    return r;
  }

  private async fetchText(url: string): Promise<string> {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    try {
      const r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': 'Vaysen AI CRM/2.0' } });
      return r.ok ? await r.text() : '';
    } catch { return ''; }
    finally { clearTimeout(t); }
  }

  private stripHtml(v: string): string {
    return v.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  }

  private isRoleEmail(email: string): boolean {
    return /^(info|contact|hello|sales|support|service|admin|office|customerservice|press|media|marketing|hr|jobs|careers|accounts|finance|billing|webmaster|postmaster|abuse|security|privacy|enquiries|inquiry|help|orders|store|shop|b2b|wholesale|social|brand|partnerships)@/i.test(email);
  }

  private isFreeEmail(email: string): boolean {
    const free = ['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com','yahoo.com','ymail.com','protonmail.com','proton.me','pm.me','aol.com','aim.com','icloud.com','me.com','mac.com','mail.com','zoho.com','gmx.com','gmx.de','fastmail.com','tutanota.com','tuta.io','mail.ru','qq.com','163.com','126.com','yeah.net','sina.com','sohu.com'];
    const d = email.split('@')[1]?.toLowerCase();
    return free.includes(d || '');
  }

  private extractDomain(url: string): string | null {
    try {
      const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
      return host.replace(/^www\./, '');
    } catch {
      return null;
    }
  }

    private async duckDuckGoSearch(
    query: string,
    max: number,
  ): Promise<Array<{ title: string; url: string; snippet: string }>> {
    // Delegates to SearXNG (which uses Clash proxy to reach real search engines)
    try {
      const base = process.env.SEARXNG_URL || process.env.SEARXNG_BASE_URL || 'http://127.0.0.1:8080';
      const url = `${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json&language=en`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Vaysen AI CRM/2.0' },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      const rows = Array.isArray(data.results) ? data.results : [];
      return rows.slice(0, max).map((item: any) => ({
        title: String(item.title || '').replace(/<[^>]*>/g, ''),
        url: item.url || '',
        snippet: String(item.content || item.snippet || '').replace(/<[^>]*>/g, ''),
      })).filter((item: any) => item.url && /^https?:\/\//i.test(item.url));
    } catch {
      return [];
    }
  }
  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
