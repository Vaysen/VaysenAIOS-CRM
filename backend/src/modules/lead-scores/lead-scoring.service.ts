import { Injectable } from '@nestjs/common';

export interface ScoreBreakdown {
  baseInfo: { field: string; points: number; reason: string }[];
  contact: { field: string; points: number; reason: string }[];
  sourceCredibility: { field: string; points: number; reason: string }[];
  behavior: { field: string; points: number; reason: string }[];
  riskDeductions: { field: string; points: number; reason: string }[];
}

export interface ScoreResult {
  score: number;
  grade: string;
  scoreReason: string;
  breakdown: ScoreBreakdown;
}

const FREE_EMAIL_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'aol.com', 'icloud.com', 'protonmail.com', 'mail.com', 'gmx.com',
  'yandex.com', 'zoho.com', 'inbox.com', 'fastmail.com', '163.com',
  '126.com', 'qq.com', 'sina.com', 'sohu.com', 'yeah.net',
];

@Injectable()
export class LeadScoringService {
  calculateScore(lead: any): ScoreResult {
    const breakdown: ScoreBreakdown = {
      baseInfo: [],
      contact: [],
      sourceCredibility: [],
      behavior: [],
      riskDeductions: [],
    };

    let score = 0;

    // ========== BASE INFO ==========
    if (lead.companyName) {
      score += 10;
      breakdown.baseInfo.push({ field: 'companyName', points: 10, reason: 'Has company name' });
    }

    if (lead.website) {
      score += 15;
      breakdown.baseInfo.push({ field: 'website', points: 15, reason: 'Has website' });
    }

    if (lead.country) {
      score += 8;
      breakdown.baseInfo.push({ field: 'country', points: 8, reason: 'Has country' });
    }

    if (lead.industry) {
      score += 5;
      breakdown.baseInfo.push({ field: 'industry', points: 5, reason: 'Has industry' });
    }

    if (lead.productCategory) {
      score += 5;
      breakdown.baseInfo.push({ field: 'productCategory', points: 5, reason: 'Has product category' });
    }

    // ========== CONTACT ==========
    if (lead.contactName) {
      score += 8;
      breakdown.contact.push({ field: 'contactName', points: 8, reason: 'Has contact name' });
    }

    if (lead.contactTitle) {
      score += 5;
      breakdown.contact.push({ field: 'contactTitle', points: 5, reason: 'Has contact title' });
    }

    if (lead.contactEmail) {
      score += 15;
      breakdown.contact.push({ field: 'contactEmail', points: 15, reason: 'Has email' });

      if (this.isValidEmail(lead.contactEmail)) {
        score += 5;
        breakdown.contact.push({ field: 'contactEmail', points: 5, reason: 'Email format valid' });

        if (this.isCorporateEmail(lead.contactEmail)) {
          score += 10;
          breakdown.contact.push({ field: 'contactEmail', points: 10, reason: 'Corporate email (not free provider)' });
        }
      }
    }

    if (lead.contactPhone) {
      score += 5;
      breakdown.contact.push({ field: 'contactPhone', points: 5, reason: 'Has phone' });
    }

    if (lead.whatsapp) {
      score += 5;
      breakdown.contact.push({ field: 'whatsapp', points: 5, reason: 'Has WhatsApp' });
    }

    // ========== SOURCE CREDIBILITY ==========
    if (lead.sourceUrl) {
      score += 10;
      breakdown.sourceCredibility.push({ field: 'sourceUrl', points: 10, reason: 'Has source URL' });
    }

    if (lead.sourceType && lead.sourceType !== 'manual') {
      score += 5;
      breakdown.sourceCredibility.push({ field: 'sourceType', points: 5, reason: `Source type: ${lead.sourceType}` });
    }

    if (lead.sourceKeyword) {
      score += 3;
      breakdown.sourceCredibility.push({ field: 'sourceKeyword', points: 3, reason: 'Has source keyword' });
    }

    if (lead.sourceCountry) {
      score += 3;
      breakdown.sourceCredibility.push({ field: 'sourceCountry', points: 3, reason: 'Has source country' });
    }

    // ========== BEHAVIOR (PIPELINE STAGE-BASED) ==========
    const statusScores: Record<string, number> = {
      replied: 30,
      interested: 45,
      quoted: 35,
      won: 50,
    };

    if (lead.status && statusScores[lead.status]) {
      const pts = statusScores[lead.status];
      score += pts;
      breakdown.behavior.push({ field: 'status', points: pts, reason: `Stage: ${lead.status}` });
    }

    // ========== RISK DEDUCTIONS ==========
    if (lead.isUncertain) {
      score -= 15;
      breakdown.riskDeductions.push({ field: 'isUncertain', points: -15, reason: 'Data marked as uncertain' });
    }

    if (lead.status === 'lost') {
      score -= 30;
      breakdown.riskDeductions.push({ field: 'status', points: -30, reason: 'Lead marked as lost/invalid' });
    }

    // Email invalid (has email but format is wrong)
    if (lead.contactEmail && !this.isValidEmail(lead.contactEmail)) {
      score -= 20;
      breakdown.riskDeductions.push({ field: 'contactEmail', points: -20, reason: 'Invalid email format' });
    }

    // No contact info at all
    const hasAnyContact = lead.contactEmail || lead.contactPhone || lead.whatsapp || lead.linkedinUrl || lead.facebookUrl;
    if (!hasAnyContact) {
      score -= 25;
      breakdown.riskDeductions.push({ field: 'contact', points: -25, reason: 'No contact information available' });
    }

    // No source URL
    if (!lead.sourceUrl) {
      score -= 10;
      breakdown.riskDeductions.push({ field: 'sourceUrl', points: -10, reason: 'No source URL' });
    }

    // Clamp score to 0-100
    score = Math.max(0, Math.min(100, score));

    const grade = this.scoreToGrade(score);
    const scoreReason = this.buildScoreReason(score, grade, breakdown);

    return { score, grade, scoreReason, breakdown };
  }

  private scoreToGrade(score: number): string {
    if (score >= 80) return 'A';
    if (score >= 60) return 'B';
    if (score >= 40) return 'C';
    return 'D';
  }

  private buildScoreReason(score: number, grade: string, breakdown: ScoreBreakdown): string {
    const totalAdds = [...breakdown.baseInfo, ...breakdown.contact, ...breakdown.sourceCredibility, ...breakdown.behavior]
      .reduce((sum, item) => sum + item.points, 0);
    const totalDeducts = breakdown.riskDeductions.reduce((sum, item) => sum + item.points, 0);

    return `Score: ${score} (Grade ${grade}). ` +
      `Base+Contact+Source+Behavior: +${totalAdds}, Deductions: ${totalDeducts}. ` +
      `Grade A: 80-100 (High Priority), B: 60-79 (Normal), C: 40-59 (Low), D: 0-39 (Not Recommended).`;
  }

  private isValidEmail(email: string): boolean {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
  }

  private isCorporateEmail(email: string): boolean {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return false;
    return !FREE_EMAIL_DOMAINS.includes(domain);
  }
}
