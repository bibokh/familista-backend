/**
 * Familista manufacturing preparation (P5) — a saved version's tech pack, built on the server from the version itself:
 * for each surface of the garment, its size and base colour, and every element placed on it, with its colour (palette
 * name and hex), its position and size in millimetres from the surface's top-left corner, its rotation, and what it
 * says. What a maker needs to reproduce the design; nothing about a person (a roster layer names its field, never a
 * name). Its sha256 ties it to exactly one version; it is recorded when it leaves the platform.
 */
import { createHash } from 'crypto';
import { prisma } from '../../config/database';
import { NotFoundError } from '../../utils/errors';
import { templateInfo } from '../product-design/core';
import { tenantAudit } from '../product-design/club-audit';
import type { DesignActor } from '../product-design/service';
import { tenantWhere, type Tenant } from '../tenancy/tenant';

type Layer = Record<string, unknown> & { id: string; type: string; name?: string; visible?: boolean };
export type TechPackDoc = Doc;
type Doc = { name: string; template: { key: string; version: number }; palette: Array<{ id: string; label: string; srgb: string }>; surfaces: Array<{ id: string; base: string; layers: Layer[] }> };

export interface TechPackElement {
  surface: string; element: string; type: string; text: string | null; font: string | null; colour: string | null; hex: string | null;
  xMm: number | null; yMm: number | null; widthMm: number | null; heightMm: number | null; rotationDeg: number | null; printed: boolean;
}

/** The version the project's head names, as stored. */
async function headOf(t: Tenant, projectId: string) {
  const p = await prisma.designProject.findFirst({ where: { id: projectId, ...tenantWhere(t) }, select: { id: true, name: true, headRevision: true, templateKey: true, templateVersion: true } });
  if (!p) throw new NotFoundError('Design project');
  const rev = await prisma.designRevision.findUnique({ where: { projectId_number: { projectId, number: p.headRevision } }, select: { number: true, sha256: true, document: true, createdAt: true } });
  if (!rev) throw new NotFoundError('Design revision');
  return { project: p, revision: rev };
}
const round = (n: unknown) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 10) / 10 : null);

export function buildTechPack(project: { id: string; name: string }, revision: { number: number; sha256: string; createdAt: Date }, doc: Doc) {
  const info = templateInfo(doc.template.key, doc.template.version);
  const swatch = new Map(doc.palette.map((s) => [s.id, s]));
  const colourOf = (id: unknown) => { const s = typeof id === 'string' ? swatch.get(id) : undefined; return s ? { colour: s.label, hex: s.srgb.toLowerCase() } : { colour: null, hex: null }; };
  const label = (id: string) => info?.surfaces.find((s) => s.id === id)?.label ?? id;
  const elements: TechPackElement[] = [];
  const surfaces = doc.surfaces.map((s) => {
    const dims = info?.surfaces.find((x) => x.id === s.id);
    const base = colourOf(s.base);
    for (const l of s.layers) {
      const c = colourOf(l.color);
      elements.push({
        surface: label(s.id), element: String(l.name ?? l.id), type: l.type,
        text: l.type === 'text' ? String(l.text ?? '') : l.type === 'roster' ? `{${String(l.field ?? '')}}` : l.type === 'pattern' ? String(l.pattern ?? '') : l.type === 'shape' ? String(l.shape ?? '') : null,
        font: typeof l.font === 'string' ? l.font : null, colour: c.colour, hex: c.hex,
        xMm: round(l.x), yMm: round(l.y), widthMm: round(l.w), heightMm: round(l.h), rotationDeg: round(l.r), printed: l.visible !== false,
      });
    }
    return { id: s.id, label: label(s.id), widthMm: dims?.widthMm ?? null, heightMm: dims?.heightMm ?? null, base: { colour: base.colour, hex: base.hex }, elements: s.layers.length };
  });
  return {
    format: 'familista.tech-pack', version: 1,
    design: { id: project.id, name: project.name, revision: revision.number, sha256: revision.sha256, savedAt: revision.createdAt.toISOString() },
    garment: { template: doc.template.key, templateVersion: doc.template.version, name: info?.name ?? doc.template.key, form: info?.form ?? null },
    palette: doc.palette.map((p) => ({ colour: p.label, hex: p.srgb.toLowerCase() })),
    surfaces, elements,
    note: 'Positions and sizes are millimetres from the top-left corner of each surface as the template draws it; rotation is degrees clockwise. A roster element names its field: names and numbers come from the order’s production sheet.',
  };
}

const CSV_HEAD = ['surface', 'element', 'type', 'text', 'font', 'colour', 'hex', 'x_mm', 'y_mm', 'width_mm', 'height_mm', 'rotation_deg', 'printed'];
/**
 * CSV, RFC 4180, UTF-8 with a BOM (spreadsheets open it in every language). A text cell starting with = + - @ (a
 * formula to a spreadsheet) is written as text with a leading apostrophe; a number is written as the number it is, so a
 * negative position stays a number.
 */
export function techPackCsv(rows: TechPackElement[]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + [CSV_HEAD.join(','), ...rows.map((r) => [r.surface, r.element, r.type, r.text, r.font, r.colour, r.hex, r.xMm, r.yMm, r.widthMm, r.heightMm, r.rotationDeg, r.printed ? 'yes' : 'no'].map(cell).join(','))].join('\r\n') + '\r\n';
}

/** The tech pack of a project's newest version, recorded as it leaves (P5: manufacturing preparation). */
export async function techPack(t: Tenant, actor: DesignActor, projectId: string, format: 'json' | 'csv') {
  const { project, revision } = await headOf(t, projectId);
  const pack = buildTechPack(project, revision, revision.document as unknown as Doc);
  const csv = format === 'csv' ? techPackCsv(pack.elements) : null;
  const sha = createHash('sha256').update(csv ?? JSON.stringify(pack)).digest('hex');
  await prisma.$transaction((tx) => tenantAudit(tx, t, actor, { action: 'design.tech-pack.exported', resourceType: 'DesignProject', resourceId: projectId,
    metadata: { revision: revision.number, sha256: revision.sha256, format, bytes: (csv ?? JSON.stringify(pack)).length, exportSha256: sha }, message: 'A tech pack left the platform' }));
  return { pack, csv, fileName: `${project.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'design'} v${revision.number} tech pack.${format}` };
}

/** P5: the professional export — the version a print sheet is drawn from, recorded as it leaves. */
export async function proExport(t: Tenant, actor: DesignActor, projectId: string) {
  const { project, revision } = await headOf(t, projectId);
  await prisma.$transaction((tx) => tenantAudit(tx, t, actor, { action: 'design.export.created', resourceType: 'DesignProject', resourceId: projectId,
    metadata: { revision: revision.number, sha256: revision.sha256, kind: 'print-sheet' }, message: 'A professional export of a design version was made' }));
  return { export: { projectId: project.id, name: project.name, revision: revision.number, sha256: revision.sha256, document: revision.document, at: new Date().toISOString() } };
}
