import { Injectable } from '@nestjs/common';

@Injectable()
export class ReportTemplateService {

  /** Generate a Example Trading Company Chinese HTML background-check report. */
  generateBackgroundCheckHtml(data: any, leadInfo: any): string {
    const css = this.getBaseCss();
    const r = data;
    const now = new Date().toLocaleDateString('zh-CN');

    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${this.esc(leadInfo.companyName || '')} - 深度背调报告</title>${css}</head><body>
<div class="report-container">
${this.header('客户背景调查报告', leadInfo.companyName || '', now)}
${this.executiveSummary(r.executiveSummary || '')}
${this.companyBasicInfo(r.companyBasicInfo, r)}
${this.addressAnalysis(r.businessAddressAnalysis, r.registryData)}
${this.marketAnalysis(r.marketAnalysis)}
${this.socialMediaAudit(r.socialMediaAudit, r.gatheredSocial)}
${this.websiteAnalysis(r.websiteAnalysis, r.trafficData)}
${this.salesEstimate(r.salesEstimate)}
${this.keyContacts(r.keyContacts, r.discoveredContacts)}
${this.riskAssessment(r.riskAssessment)}
${this.cooperationStrategy(r.cooperationStrategy)}
${this.dataSources(r.dataSources || [])}
${this.footer(now)}
</div></body></html>`;
  }

  generateContactDiscoveryHtml(data: any, leadInfo: any): string {
    const css = this.getBaseCss();
    const now = new Date().toLocaleDateString('zh-CN');
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${this.esc(leadInfo.companyName || '')} - 联系人深挖报告</title>${css}</head><body>
<div class="report-container">
${this.header('联系人深度挖掘报告', leadInfo.companyName, now)}
${this.contactSummary(data)}
${this.confirmedContactsTable(data.keyContacts?.confirmed || [])}
${this.unconfirmedContacts(data.keyContacts?.unconfirmed || [])}
${this.socialProfileDiscovery(data.socialProfiles || [])}
${this.emailPatternAnalysis(data.emailPatterns || '')}
${this.footer(now)}
</div></body></html>`;
  }

  generateMarketAnalysisHtml(data: any, leadInfo: any): string {
    const css = this.getBaseCss();
    const now = new Date().toLocaleDateString('zh-CN');
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${this.esc(leadInfo.companyName || '')} - 市场分析报告</title>${css}</head><body>
<div class="report-container">
${this.header('市场分析与合作建议报告', leadInfo.companyName, now)}
${this.businessModelAnalysis(data.businessModel || {})}
${this.marketPositionAnalysis(data.marketPosition || {})}
${this.productMatchAnalysis(data.productMatch || {})}
${this.cooperationStrategy(data.cooperationStrategy || {})}
${this.pitchAngles(data.pitchAngles || [])}
${this.footer(now)}
</div></body></html>`;
  }

  /** Convert JSON report data to HTML for archive display */
  archiveJsonToHtml(jsonData: any, type: string, leadName: string): string {
    switch (type) {
      case 'full': return this.generateBackgroundCheckHtml(jsonData, { companyName: leadName });
      case 'contacts': return this.generateContactDiscoveryHtml(jsonData, { companyName: leadName });
      case 'market': return this.generateMarketAnalysisHtml(jsonData, { companyName: leadName });
      default: return `<p>Unknown report type: ${type}</p>`;
    }
  }

  // ========== Section Builders ==========

  private header(title: string, companyName: string, date: string): string {
    return `<div class="report-header">
<h1>${this.esc(title)}</h1>
<div class="subtitle">调查对象：${this.esc(companyName)} | 报告日期：${date} | 调查范围：公司实体 / 经营地址 / 主要市场 / 独立站 / 流量分析 / 联络人</div>
</div>`;
  }

  private executiveSummary(text: string): string {
    return `<div class="section"><h2>一、执行摘要</h2><p>${this.esc(text)}</p></div>`;
  }

  private companyBasicInfo(info: any, fullData: any): string {
    if (!info) return '';
    const rows = [
      ['公司名称', info.legalName || '未确认'],
      ['注册国家', info.country || '未确认'],
      ['成立时间', info.founded || '未确认'],
      ['公司类型', info.companyType || '未确认'],
      ['公司状态', info.registrationStatus || '未确认'],
      ['员工规模', info.employeeCount || '未确认'],
      ['年营收估算', info.annualRevenue || '未确认'],
    ];
    return `<div class="section"><h2>二、公司基本信息</h2>${this.table(rows)}
${info.confidence ? `<p class="note">数据来源：${this.esc(fullData.dataSources?.[0] || '公开网络信息')}</p>` : ''}</div>`;
  }

  private addressAnalysis(addr: any, registry: any): string {
    if (!addr && !registry) return '';
    const rows = [
      ['注册地址', addr?.registeredAddress || '未确认'],
      ['实际经营地址', addr?.operatingAddress || '未确认'],
      ['地址类型', addr?.addressType || '未确认'],
      ['是否为实体办公室', addr?.isRealOffice ? '是' : '否/未确认'],
    ];
    return `<div class="section"><h2>三、经营地址分析</h2>${this.table(rows)}
${addr?.notes ? `<p class="note">${this.esc(addr.notes)}</p>` : ''}</div>`;
  }

  private marketAnalysis(ma: any): string {
    if (!ma) return '';
    return `<div class="section"><h2>四、市场分析</h2>
<p><strong>目标市场：</strong>${this.esc(Array.isArray(ma.targetMarkets) ? ma.targetMarkets.join('、') : ma.targetMarkets || '')}</p>
<p><strong>目标客户画像：</strong>${this.esc(ma.targetCustomerProfile || ma.stylePreference || '')}</p>
<p><strong>品牌定位：</strong>${this.esc(ma.brandPositioning || '')}</p>
<p><strong>价格区间：</strong>${this.esc(ma.priceRange || '')}</p>
<p><strong>主营产品线：</strong>${this.esc(Array.isArray(ma.mainProductLines) ? ma.mainProductLines.join('、') : '')}</p></div>`;
  }

  private socialMediaAudit(sma: any, gathered: any): string {
    const platforms = sma?.platforms || [];
    if (!platforms.length && !gathered) return '';
    let html = '<div class="section"><h2>五、社交媒体与在线渠道</h2>';
    if (platforms.length > 0) {
      html += '<table class="data-table"><tr><th>平台</th><th>账号</th><th>粉丝</th><th>备注</th></tr>';
      for (const p of platforms) {
        html += `<tr><td>${this.esc(p.platform)}</td><td>${this.esc(p.handle)}</td><td>${p.followers || '-'}</td><td>${this.esc(p.notes || p.engagement || '')}</td></tr>`;
      }
      html += '</table>';
    }
    if (sma?.overallAssessment) html += `<p class="note">${this.esc(sma.overallAssessment)}</p>`;
    html += '</div>';
    return html;
  }

  private websiteAnalysis(wa: any, traffic: any): string {
    if (!wa && !traffic) return '';
    const rows = [
      ['网站平台', wa?.platform || '未确认'],
      ['是否Shopify', wa?.isShopify ? '是' : '否'],
      ['有无在线商店', wa?.hasOnlineStore ? '有' : '未确认'],
      ['流量估算', wa?.trafficEstimate || traffic?.similarweb || '暂无数据'],
    ];
    return `<div class="section"><h2>六、独立站与网站流量分析</h2>${this.table(rows)}
${wa?.notes ? `<p class="note">${this.esc(wa.notes)}</p>` : ''}</div>`;
  }

  private salesEstimate(se: any): string {
    if (!se) return '';
    const rows = [
      ['月访问量', se.monthlyTraffic || '暂无数据'],
      ['转化率参考', se.conversionRate || '2%-3%（行业平均）'],
      ['预估月销量', se.estimatedMonthlySales || '暂无数据'],
      ['预估年销量', se.estimatedAnnualSales || '暂无数据'],
    ];
    return `<div class="section"><h2>七、销量估算</h2>${this.table(rows)}</div>`;
  }

  private keyContacts(kc: any, discovered: any[]): string {
    const confirmed = kc?.confirmed || [];
    const unconfirmed = kc?.unconfirmed || [];
    const allDiscovered = discovered || [];

    let html = '<div class="section"><h2>八、关键联系人</h2>';

    if (confirmed.length > 0) {
      html += '<h3>已确认联系人</h3>';
      for (const c of confirmed) {
        html += `<div class="contact-card">
<div class="contact-name">${this.esc(c.name)}${c.title ? ` — ${this.esc(c.title)}` : ''}</div>
${c.email ? `<div>📧 <a href="mailto:${this.esc(c.email)}">${this.esc(c.email)}</a></div>` : ''}
${c.phone ? `<div>📱 ${this.esc(c.phone)}</div>` : ''}
${c.linkedin ? `<div>🔗 <a href="${this.esc(c.linkedin)}" target="_blank">LinkedIn</a></div>` : ''}
<div class="source">来源：${this.esc(c.source || 'AI分析')}</div></div>`;
      }
    }

    if (allDiscovered.length > 0) {
      html += '<h3>网站发现的联系方式</h3>';
      for (const d of allDiscovered.slice(0, 5)) {
        html += `<div class="contact-card-mini">
<span>📧 ${this.esc(d.email)}</span> <span class="source">(${this.esc(d.source)})</span>
</div>`;
      }
    }

    if (unconfirmed.length > 0) {
      html += '<h3>待确认联系人</h3>';
      for (const c of unconfirmed) {
        html += `<p>• ${this.esc(c.name)} — ${this.esc(c.title)} — 验证方式：${this.esc(c.howToVerify)}</p>`;
      }
    }
    html += '</div>';
    return html;
  }

  private riskAssessment(ra: any): string {
    if (!ra) return '';
    const dimensions = [
      ['公司正规性', ra.companyLegitimacy],
      ['品牌成熟度', ra.brandMaturity],
      ['采购潜力', ra.procurementPotential],
    ];
    let html = '<div class="section"><h2>九、风险评估</h2>';
    for (const [label, dim] of dimensions) {
      if (!dim) continue;
      const score = typeof dim === 'object' ? dim.score : dim;
      const color = score >= 4 ? '#22c55e' : score >= 2 ? '#f59e0b' : '#ef4444';
      html += `<div class="risk-item"><span>${label}：</span><span style="color:${color};font-size:20px">${'★'.repeat(Math.min(5, score))}${'☆'.repeat(Math.max(0, 5 - score))}</span><span>(${score}/5)</span></div>`;
      if (typeof dim === 'object' && dim.notes) html += `<p class="note">${this.esc(dim.notes)}</p>`;
    }
    html += `<p class="overall-score">综合评分：<strong>${ra.overallScore || '-'}</strong> — ${this.esc(ra.overallGrade || '')}</p>
<p class="note">${this.esc(ra.recommendation || '')}</p></div>`;
    return html;
  }

  private cooperationStrategy(cs: any): string {
    if (!cs) return '';
    return `<div class="section"><h2>十、合作建议</h2>
<p><strong>短期：</strong>${this.esc(cs.shortTerm || '')}</p>
<p><strong>中期：</strong>${this.esc(cs.midTerm || '')}</p>
<p><strong>长期：</strong>${this.esc(cs.longTerm || '')}</p>
<p><strong>推荐产品：</strong>${this.esc(Array.isArray(cs.recommendedProducts) ? cs.recommendedProducts.join('、') : '')}</p>
<p><strong>邮件角度：</strong>${this.esc(Array.isArray(cs.emailAngles) ? cs.emailAngles.join('；') : '')}</p>
<p><strong>下一步：</strong>${this.esc(Array.isArray(cs.nextActions) ? cs.nextActions.join('；') : '')}</p></div>`;
  }

  private contactSummary(data: any): string {
    const count = data.keyContacts?.confirmed?.length || 0;
    return `<div class="section"><h2>一、挖掘总结</h2><p>本次共发现 <strong>${count}</strong> 个已确认联系人，${data.discoveredContacts?.length || 0} 个网站邮箱。</p></div>`;
  }

  private confirmedContactsTable(contacts: any[]): string {
    if (!contacts?.length) return '';
    let html = '<div class="section"><h2>二、已确认联系人详情</h2><table class="data-table"><tr><th>姓名</th><th>职位</th><th>邮箱</th><th>电话</th><th>LinkedIn</th><th>来源</th></tr>';
    for (const c of contacts) {
      html += `<tr><td>${this.esc(c.name)}</td><td>${this.esc(c.title)}</td><td>${c.email ? `<a href="mailto:${this.esc(c.email)}">${this.esc(c.email)}</a>` : '-'}</td><td>${this.esc(c.phone || '-')}</td><td>${c.linkedin ? `<a href="${this.esc(c.linkedin)}">查看</a>` : '-'}</td><td>${this.esc(c.source || '')}</td></tr>`;
    }
    html += '</table></div>';
    return html;
  }

  private unconfirmedContacts(contacts: any[]): string {
    if (!contacts?.length) return '';
    let html = '<div class="section"><h2>三、待确认联系人</h2>';
    for (const c of contacts) {
      html += `<p>• <strong>${this.esc(c.name)}</strong> — ${this.esc(c.title)} — 验证方式：${this.esc(c.howToVerify)}</p>`;
    }
    html += '</div>';
    return html;
  }

  private socialProfileDiscovery(profiles: any[]): string {
    if (!profiles?.length) return '';
    let html = '<div class="section"><h2>四、社交媒体发现</h2><table class="data-table"><tr><th>联系人</th><th>平台</th><th>账号/URL</th></tr>';
    for (const p of profiles) {
      html += `<tr><td>${this.esc(p.name)}</td><td>${this.esc(p.platform)}</td><td><a href="${this.esc(p.url)}">${this.esc(p.handle || p.url)}</a></td></tr>`;
    }
    html += '</table></div>';
    return html;
  }

  private emailPatternAnalysis(pattern: string): string {
    if (!pattern) return '';
    return `<div class="section"><h2>五、邮箱格式分析</h2><p>${this.esc(pattern)}</p></div>`;
  }

  private businessModelAnalysis(bm: any): string {
    if (!bm) return '';
    const rows = [
      ['商业模式', bm.type || ''],
      ['网站平台', bm.platform || ''],
      ['目标市场', bm.targetMarket || ''],
      ['营销渠道', bm.marketingChannels || ''],
    ];
    return `<div class="section"><h2>一、商业模式分析</h2>${this.table(rows)}</div>`;
  }

  private marketPositionAnalysis(mp: any): string {
    if (!mp) return '';
    return `<div class="section"><h2>二、市场定位</h2>
<p><strong>品牌定位：</strong>${this.esc(mp.positioning || '')}</p>
<p><strong>竞品参考：</strong>${this.esc(Array.isArray(mp.competitors) ? mp.competitors.join('、') : '')}</p>
<p><strong>差异化优势：</strong>${this.esc(mp.differentiation || '')}</p></div>`;
  }

  private productMatchAnalysis(pm: any): string {
    if (!pm) return '';
    const score = pm.score || 0;
    const scoreColor = score >= 70 ? '#22c55e' : score >= 40 ? '#f59e0b' : '#ef4444';
    return `<div class="section"><h2>三、产品匹配度</h2>
<div class="match-score" style="color:${scoreColor}">${score}/100</div>
<p><strong>推荐产品：</strong>${this.esc(Array.isArray(pm.recommendedProducts) ? pm.recommendedProducts.join('、') : '')}</p>
<p><strong>推荐材质：</strong>${this.esc(pm.recommendedMaterials || '')}</p>
<p><strong>推荐价格：</strong>${this.esc(pm.recommendedPrice || '')}</p>
<p><strong>合作模式：</strong>${this.esc(pm.cooperationModel || '')}</p></div>`;
  }

  private pitchAngles(angles: any[]): string {
    if (!angles?.length) return '';
    let html = '<div class="section"><h2>四、开发信角度建议</h2>';
    for (const a of angles) {
      html += `<p>• <strong>${this.esc(a.subject || '')}</strong> — ${this.esc(a.body || a.angle || '')}</p>`;
    }
    html += '</div>';
    return html;
  }

  private dataSources(sources: any[]): string {
    if (!sources?.length) return `<div class="section"><h2>数据来源</h2><p>智谱 GLM 分析 + 已提供的公开信息</p></div>`;
    let html = '<div class="section"><h2>十一、数据来源</h2><ul>';
    for (const s of sources) { html += `<li>${this.esc(typeof s === 'string' ? s : s.name || s.url || JSON.stringify(s))}</li>`; }
    html += '</ul></div>';
    return html;
  }

  private footer(date: string): string {
    return `<div class="footer"><p>本报告基于公开可查的网络信息编制，仅供参考。报告日期：${date}</p><p>Generated by Vaysen AI CRM — AI Deep Research Engine</p></div>`;
  }

  // ========== Helpers ==========

  private table(rows: string[][]): string {
    let html = '<table class="data-table">';
    for (const [k, v] of rows) {
      html += `<tr><td class="label">${this.esc(k)}</td><td>${this.esc(String(v || '未确认'))}</td></tr>`;
    }
    html += '</table>';
    return html;
  }

  private esc(text: string): string {
    if (!text) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private getBaseCss(): string {
    return `<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif; font-size: 14px; line-height: 1.8; color: #1a1a2e; background: #f8f9fa; }
.report-container { max-width: 900px; margin: 0 auto; padding: 40px 30px; background: #fff; box-shadow: 0 2px 20px rgba(0,0,0,0.08); }
.report-header { border-bottom: 3px solid #2563eb; padding-bottom: 20px; margin-bottom: 30px; }
.report-header h1 { font-size: 28px; color: #1e3a5f; margin-bottom: 8px; }
.report-header .subtitle { font-size: 13px; color: #6b7280; }
.section { margin-bottom: 30px; padding-bottom: 20px; border-bottom: 1px solid #e5e7eb; }
.section h2 { font-size: 20px; color: #1e40af; margin-bottom: 15px; padding-left: 10px; border-left: 4px solid #2563eb; }
.section h3 { font-size: 16px; color: #374151; margin: 12px 0 8px; }
.data-table { width: 100%; border-collapse: collapse; margin: 10px 0; }
.data-table td { padding: 8px 12px; border: 1px solid #e5e7eb; }
.data-table td.label { background: #f0f4ff; font-weight: 600; width: 30%; color: #1e3a5f; }
.contact-card { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 12px 16px; margin: 8px 0; }
.contact-card-mini { background: #fffbeb; border: 1px solid #fde68a; border-radius: 4px; padding: 6px 10px; margin: 4px 0; font-size: 13px; }
.contact-name { font-weight: 600; font-size: 15px; margin-bottom: 4px; }
.source { font-size: 11px; color: #9ca3af; }
.note { font-size: 12px; color: #6b7280; margin-top: 8px; font-style: italic; }
.risk-item { margin: 8px 0; font-size: 15px; }
.overall-score { font-size: 18px; margin: 15px 0 8px; padding: 10px; background: #f8fafc; border-radius: 6px; }
.match-score { font-size: 48px; font-weight: 700; text-align: center; margin: 15px 0; }
.footer { margin-top: 40px; padding-top: 20px; border-top: 2px solid #e5e7eb; font-size: 11px; color: #9ca3af; text-align: center; }
@media print { body { background: #fff; } .report-container { box-shadow: none; max-width: 100%; } }
</style>`;
  }
}
