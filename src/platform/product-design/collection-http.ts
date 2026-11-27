/**
 * Familista Design Studio — the HTTP handlers of a club's collections (M3b), mounted by src/routes/club-design.routes.ts
 * behind its gate (authenticate, the club roles that design kits, the club's entitlement). The club is the one the gate
 * resolved from the session (`res.locals.designScope`); a handler reached without a club scope refuses, never serves.
 */
import type { Request, RequestHandler, Response } from 'express';
import { designActorOf as actorOf, tenantOfRes } from './scope-http';
import type { Tenant } from '../tenancy/tenant';
import { DesignCollectionRole } from '@prisma/client';
import { z } from 'zod';
import {
  createCollection, deleteCollection, getCollection, listCollections, orderSheet, saveCollection, setCollectionArchived,
  CollectionConflictError, CollectionInvalidError, CollectionRefusedError, COLLECTION_ITEM_LIMIT,
} from './collection.service';
import type { DesignActor, DesignScope } from './service';

const Id = z.string().guid();
const Role = z.enum([DesignCollectionRole.HOME, DesignCollectionRole.AWAY, DesignCollectionRole.THIRD, DesignCollectionRole.GOALKEEPER, DesignCollectionRole.TRAINING, DesignCollectionRole.OTHER]);
const Fields = {
  name: z.string().max(400),
  season: z.string().max(100).nullable().default(null),
  rosterId: Id.nullable().default(null),
  items: z.array(z.object({ projectId: Id, role: Role }).strict()).max(COLLECTION_ITEM_LIMIT * 4).default([]),
};
const CreateBody = z.object(Fields).strict();
const SaveBody = z.object({ ...Fields, version: z.number().int().min(1).max(1_000_000) }).strict();
const ListQuery = z.object({ state: z.enum(['active', 'archived']).default('active') }).strict();
const SheetQuery = z.object({ rosterId: Id.optional() }).strict();

function handler(work: (req: Request, res: Response, tenant: Tenant) => Promise<void>): RequestHandler {
  return async (req, res, next) => {
    try { await work(req, res, tenantOfRes(res)); } catch (err) {
      if (err instanceof CollectionInvalidError) {
        res.status(400).json({ success: false, code: 'COLLECTION_INVALID', reason: err.code, path: err.path, message: `The collection was refused: ${err.message}` });
        return;
      }
      if (err instanceof CollectionConflictError) { res.status(409).json({ success: false, code: err.code, message: err.message, data: { version: err.version } }); return; }
      if (err instanceof CollectionRefusedError) { res.status(409).json({ success: false, code: err.code, message: err.message }); return; }
      next(err);
    }
  };
}

export const listDesignCollections = handler(async (req, res, tenant) => {
  const { state } = ListQuery.parse(req.query);
  res.json({ success: true, data: await listCollections(tenant, { archived: state === 'archived' }) });
});
export const createDesignCollection = handler(async (req, res, tenant) => {
  res.status(201).json({ success: true, data: await createCollection(tenant, actorOf(req), CreateBody.parse(req.body)) });
});
export const openDesignCollection = handler(async (req, res, tenant) => {
  res.json({ success: true, data: await getCollection(tenant, Id.parse(req.params.collectionId)) });
});
export const saveDesignCollection = handler(async (req, res, tenant) => {
  const id = Id.parse(req.params.collectionId);
  res.json({ success: true, data: await saveCollection(tenant, actorOf(req), id, SaveBody.parse(req.body)) });
});
export const archiveDesignCollection = handler(async (req, res, tenant) => {
  res.json({ success: true, data: await setCollectionArchived(tenant, actorOf(req), Id.parse(req.params.collectionId), true) });
});
export const unarchiveDesignCollection = handler(async (req, res, tenant) => {
  res.json({ success: true, data: await setCollectionArchived(tenant, actorOf(req), Id.parse(req.params.collectionId), false) });
});
export const deleteDesignCollection = handler(async (req, res, tenant) => {
  res.json({ success: true, data: await deleteCollection(tenant, actorOf(req), Id.parse(req.params.collectionId)) });
});
export const readOrderSheet = handler(async (req, res, tenant) => {
  const { rosterId } = SheetQuery.parse(req.query);
  res.json({ success: true, data: await orderSheet(tenant, Id.parse(req.params.collectionId), rosterId) });
});
