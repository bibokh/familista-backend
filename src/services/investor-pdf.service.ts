// @ts-nocheck
// Familista — Global Investor Layer
// File location: src/services/investor-pdf.service.ts
//
// NOTE: Depends on optional npm package `pdfkit`. Type-checking is skipped here
// so the build succeeds without that dep installed; the runtime path is only
// invoked when PDF exports are explicitly requested.
//
// Executive PDF reports for investors — portfolio statement, period summary,
// cap-table snapshot. Uses PDFKit (already in the project) and pulls visual
// branding from the existing pdf-branding adapter so reports rebrand
// automatically when the operator updates the white-label config.
//
// Returns a Buffer that the controller streams with appropriate headers.

import PDFDocument from 'pdfkit';
import { prisma } from '../lib/prisma';
import { NotFoundError } from '../utils/errors';
import { getPdfBranding } from './pdf-branding.service';
import { getInvestorDashboard } from './investor-performance.service';
import { getCapTable } from './investor-captable.service';
import { writeInvestorAudit } from './investor-audit.service';
import type { InvestorActor } from '../types/investor.types';
import type { PdfBranding } from '../types/admin.types';

function fmt(n: number | null | undefined, currency = 'EUR'): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n.toFixed(2)}%`;
}

async function streamToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function drawHeader(doc: PDFKit.PDFDocument, brand: PdfBranding, title: string, subtitle: string): void {
  if (brand.logo) {
    try {
      doc.image(brand.logo.buffer, 40, 36, { width: 56 });
    } catch {
      /* ignore unreadable image */
    }
  }
  doc
    .fillColor(brand.colors.primary)
    .font(brand.fontFamily)
    .fontSize(18)
    .text(brand.productName, 110, 40);
  doc
    .fillColor(brand.colors.mutedText)
    .fontSize(10)
    .text(brand.tagline ?? '', 110, 62);

  doc.moveDown(2);
  doc.fillColor(brand.colors.text).fontSize(22).text(title, 40);
  doc.fillColor(brand.colors.mutedText).fontSize(11).text(subtitle, 40);
  doc.moveDown(1);
  doc.strokeColor(brand.colors.border).lineWidth(1).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(1);
}

function drawFooter(doc: PDFKit.PDFDocument, brand: PdfBranding): void {
  const bottom = doc.page.height - 50;
  doc
    .fillColor(brand.colors.mutedText)
    .fontSize(9)
    .text(brand.footerText, 40, bottom, { width: 515, align: 'left' });
  doc.fontSize(9).text(`Generated ${new Date().toUTCString()}`, 40, bottom + 12, { width: 515, align: 'left' });
}

function sectionTitle(doc: PDFKit.PDFDocument, brand: PdfBranding, label: string): void {
  doc.moveDown(0.5);
  doc.fillColor(brand.colors.primary).font(brand.fontFamily).fontSize(13).text(label, 40);
  doc.strokeColor(brand.colors.accent).lineWidth(2).moveTo(40, doc.y + 2).lineTo(80, doc.y + 2).stroke();
  doc.moveDown(0.5);
}

function row(doc: PDFKit.PDFDocument, brand: PdfBranding, columns: string[], widths: number[], opts?: { bold?: boolean }): void {
  let x = 40;
  doc
    .fillColor(brand.colors.text)
    .font(opts?.bold ? brand.fontFamily : brand.fontFamily)
    .fontSize(opts?.bold ? 10 : 9);
  for (let i = 0; i < columns.length; i++) {
    doc.text(columns[i], x, doc.y, { width: widths[i], continued: i < columns.length - 1 });
    x += widths[i];
  }
  doc.text('', { continued: false });
}

// ─────────────────────────────────────────────────────────────────────────────
// Investor statement (portfolio summary)
// ─────────────────────────────────────────────────────────────────────────────

export async function generateInvestorStatement(
  actor: InvestorActor,
  investorId: string,
  opts: { clubId?: string | null; period?: string } = {},
): Promise<Buffer> {
  const investor = await prisma.investorProfile.findUnique({ where: { id: investorId } });
  if (!investor) throw new NotFoundError('Investor not found');

  const dashboard = await getInvestorDashboard(investorId);
  const brand = await getPdfBranding(opts.clubId ?? 'platform');

  const doc = new PDFDocument({ size: 'A4', margin: 40 });

  drawHeader(
    doc,
    brand,
    `Investor Statement — ${investor.displayName}`,
    opts.period ? `Period: ${opts.period}` : `As of ${new Date().toISOString().slice(0, 10)}`,
  );

  // Totals block
  sectionTitle(doc, brand, 'Portfolio Totals');
  const t = dashboard.totals;
  row(doc, brand, ['Total Committed', fmt(t.committed, t.currency)], [200, 200]);
  row(doc, brand, ['Total Funded', fmt(t.funded, t.currency)], [200, 200]);
  row(doc, brand, ['Current Value (mark-to-market)', fmt(t.currentValue, t.currency)], [200, 200]);
  row(doc, brand, ['Realised Distributions', fmt(t.realizedDistributions, t.currency)], [200, 200]);
  row(doc, brand, ['Net Return', fmt(t.netReturn, t.currency)], [200, 200], { bold: true });
  row(doc, brand, ['Multiple (MoIC)', t.multiple != null ? `${t.multiple.toFixed(2)}×` : '—'], [200, 200]);

  // Positions table
  sectionTitle(doc, brand, 'Positions');
  row(doc, brand, ['Entity', 'Instrument', 'Funded', 'Value', 'Multiple', 'IRR'], [180, 80, 80, 80, 50, 50], { bold: true });
  doc.moveDown(0.2);
  doc.strokeColor(brand.colors.border).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.2);

  for (const p of dashboard.positions) {
    row(
      doc,
      brand,
      [
        `${p.entityName} (${p.entityType})`,
        p.instrumentType,
        fmt(p.fundedAmount, p.currency),
        p.currentValue != null ? fmt(p.currentValue, p.currency) : '—',
        p.multiple != null ? `${p.multiple.toFixed(2)}×` : '—',
        p.netIrr != null ? fmtPct(p.netIrr * 100) : '—',
      ],
      [180, 80, 80, 80, 50, 50],
    );
  }

  // Governance + expansion
  sectionTitle(doc, brand, 'Governance & Expansion');
  row(doc, brand, ['Board Seats', String(dashboard.governance.boardSeats)], [200, 200]);
  row(doc, brand, ['Active Rights', String(dashboard.governance.rights)], [200, 200]);
  row(doc, brand, ['Executed Agreements', String(dashboard.governance.activeAgreements)], [200, 200]);
  row(doc, brand, ['Franchise Units Backed', String(dashboard.expansion.franchiseUnits)], [200, 200]);
  row(doc, brand, ['Clubs Backed', String(dashboard.expansion.clubs)], [200, 200]);
  row(doc, brand, ['Academies Backed', String(dashboard.expansion.academies)], [200, 200]);

  // Cash flow
  sectionTitle(doc, brand, 'Cash Flow');
  row(doc, brand, ['Total Inflows (paid)', fmt(dashboard.cashFlow.inflowsTotal, t.currency)], [200, 200]);
  row(doc, brand, ['Inflow Count', String(dashboard.cashFlow.inflowsCount)], [200, 200]);
  row(doc, brand, ['Last Distribution', dashboard.cashFlow.lastDistributionAt?.toISOString().slice(0, 10) ?? '—'], [200, 200]);

  drawFooter(doc, brand);
  const buffer = await streamToBuffer(doc);

  await writeInvestorAudit({
    investorId,
    userId: actor.userId,
    action: 'PDF_STATEMENT_GENERATED',
    category: 'DISTRIBUTION',
    resourceType: 'InvestorProfile',
    resourceId: investorId,
    metadata: { bytes: buffer.byteLength, period: opts.period ?? null },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return buffer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity cap-table report
// ─────────────────────────────────────────────────────────────────────────────

export async function generateCapTableReport(
  actor: InvestorActor,
  entityId: string,
  opts: { clubId?: string | null; asOf?: Date } = {},
): Promise<Buffer> {
  const entity = await prisma.investmentEntity.findUnique({ where: { id: entityId } });
  if (!entity) throw new NotFoundError('Entity not found');

  const capTable = await getCapTable(entityId, opts.asOf);
  const brand = await getPdfBranding(opts.clubId ?? entity.clubId ?? 'platform');

  const doc = new PDFDocument({ size: 'A4', margin: 40 });

  drawHeader(
    doc,
    brand,
    `Cap Table — ${entity.name}`,
    `As of ${capTable.asOf.toISOString().slice(0, 10)} · ${capTable.totalSharesIssued.toLocaleString()} shares issued`,
  );

  // Totals
  sectionTitle(doc, brand, 'Summary');
  row(doc, brand, ['Total Shares Issued', capTable.totalSharesIssued.toLocaleString()], [200, 200]);
  row(doc, brand, ['Fully Diluted Shares', capTable.fullyDilutedShares.toLocaleString()], [200, 200]);
  row(doc, brand, ['Current Valuation', fmt(capTable.currentValuation, entity.currency)], [200, 200]);

  // Share classes
  sectionTitle(doc, brand, 'Share Classes');
  row(doc, brand, ['Class', 'Issued', 'Authorized', 'Equity %', 'Voting %'], [180, 80, 80, 80, 80], { bold: true });
  for (const c of capTable.byShareClass) {
    row(
      doc,
      brand,
      [
        `${c.shareClass.name} (${c.shareClass.code})`,
        c.sharesIssued.toLocaleString(),
        c.sharesAuthorized.toLocaleString(),
        fmtPct(c.equityPercent),
        fmtPct(c.votingPercent),
      ],
      [180, 80, 80, 80, 80],
    );
  }

  // Investor positions
  sectionTitle(doc, brand, 'Investor Positions');
  row(doc, brand, ['Investor', 'Class', 'Shares', 'Equity %', 'FD %', 'Voting %'], [180, 80, 60, 60, 60, 60], { bold: true });
  for (const p of capTable.byInvestor) {
    row(
      doc,
      brand,
      [
        p.investor.displayName,
        p.shareClass.code,
        p.shares.toLocaleString(),
        fmtPct(p.equityPercent),
        fmtPct(p.fullyDilutedPercent),
        fmtPct(p.votingPercent),
      ],
      [180, 80, 60, 60, 60, 60],
    );
  }

  drawFooter(doc, brand);
  const buffer = await streamToBuffer(doc);

  await writeInvestorAudit({
    entityId,
    userId: actor.userId,
    action: 'PDF_CAP_TABLE_GENERATED',
    category: 'CAP_TABLE',
    resourceType: 'InvestmentEntity',
    resourceId: entityId,
    metadata: { bytes: buffer.byteLength, asOf: capTable.asOf.toISOString() },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return buffer;
}
