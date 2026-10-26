/**
 * What a client is told when a request does not validate — pinned for the zod 3 → 4 migration.
 *
 * Two paths carry a zod failure to a client, and both are pure functions of the issues' paths and messages, which the
 * behaviour baseline (tests/zod-request-baseline.unit.test.ts) pins per schema:
 *   - a ZodError that reaches the error handler: 400 { success: false, message: 'Validation error', errors: [{ field, message }] };
 *   - a controller's own zerr(): 400 { success: false, message: '<field>: <message>, …' }.
 * This test pins both bodies, exactly, for real schemas and real handlers.
 */

import express from 'express';
import request from 'supertest';
import { z } from 'zod';

jest.mock('../src/config/database', () => require('./helpers/stub-database').stubDatabase({
  id: '00000000-0000-0000-0000-000000000002', clubId: '00000000-0000-0000-0000-000000000001', role: 'CLUB_ADMIN',
}));

import { errorHandler } from '../src/middleware/error.middleware';
import { createNewSession } from '../src/controllers/training.controller';
import { addDomainSchema } from '../src/utils/whitelabel.validators';

type Row = Record<string, any>;

describe('a ZodError that reaches the error handler', () => {
  const app = () => {
    const a = express();
    a.use(express.json());
    a.post('/x', (req, _res, next) => { try { addDomainSchema.parse(req.body); _res.json({ ok: true }); } catch (e) { next(e); } });
    a.use(errorHandler);
    return a;
  };

  it('is 400 { success: false, message: "Validation error", errors: [{ field, message }] }, field by field', async () => {
    const res = await request(app()).post('/x').send({ hostname: 'x', isPrimary: 'yes', extra: 1 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      message: 'Validation error',
      errors: [
        { field: 'hostname', message: 'String must contain at least 4 character(s)' },
        { field: 'isPrimary', message: 'Expected boolean, received string' },
        // A strict object's unknown key is reported at the object itself: an empty field.
        { field: '', message: "Unrecognized key(s) in object: 'extra'" },
      ],
    });
  });

  it('a missing field reads "Required"', async () => {
    const res = await request(app()).post('/x').send({});
    expect(res.body.errors).toEqual([{ field: 'hostname', message: 'Required' }]);
  });
});

describe('a controller\'s own validation message', () => {
  const call = async (body: unknown) => {
    const req = { body, user: { id: 'u', clubId: '00000000-0000-0000-0000-000000000001', role: 'CLUB_ADMIN' }, params: {}, query: {} } as Row;
    let passed: Row | undefined;
    await createNewSession(req as never, { status: () => ({ json: () => undefined }) } as never, ((e: Row) => { passed = e; }) as never);
    return passed;
  };

  it('is 400 with "<field>: <message>" for each issue, in order', async () => {
    const err = await call({ title: 12345, playerIds: ['not-a-uuid'], drills: ['NOT_A_DRILL'] });
    expect(err?.statusCode).toBe(400);
    expect(err?.message).toMatchSnapshot();
  });

  it('a body that is not an object at all', async () => {
    const err = await call('x');
    expect(err?.statusCode).toBe(400);
    expect(err?.message).toMatchSnapshot();
  });
});

describe('the messages zod itself writes, for each kind of failure the API relays', () => {
  const issues = (schema: z.ZodTypeAny, input: unknown) => {
    const r = schema.safeParse(input);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it('type, required, bounds, formats, enums, literals, unions, unknown keys, integers and custom refinements', () => {
    expect({
      type: issues(z.string(), 5),
      required: issues(z.object({ a: z.string() }), {}),
      stringMin: issues(z.string().min(3), 'a'),
      stringMax: issues(z.string().max(2), 'abc'),
      stringLength: issues(z.string().length(2), 'abc'),
      numberMin: issues(z.number().min(3), 1),
      numberGt: issues(z.number().positive(), 0),
      numberMax: issues(z.number().max(3), 9),
      numberLt: issues(z.number().negative(), 0),
      int: issues(z.number().int(), 1.5),
      arrayMin: issues(z.array(z.string()).min(2), ['a']),
      arrayMax: issues(z.array(z.string()).max(1), ['a', 'b']),
      arrayNonEmpty: issues(z.array(z.string()).nonempty(), []),
      email: issues(z.string().email(), 'x'),
      uuid: issues(z.string().uuid(), 'x'),
      url: issues(z.string().url(), 'x'),
      datetime: issues(z.string().datetime(), 'x'),
      regex: issues(z.string().regex(/^a$/), 'b'),
      enumValue: issues(z.enum(['A', 'B']), 'C'),
      nativeEnum: issues(z.nativeEnum({ A: 'A', B: 'B' } as const), 'C'),
      literal: issues(z.literal('x'), 'y'),
      union: issues(z.union([z.string(), z.number()]), true),
      strict: issues(z.object({ a: z.string() }).strict(), { a: 'x', b: 1, c: 2 }),
      custom: issues(z.string().refine(() => false, 'custom message'), 'x'),
      customDefault: issues(z.string().refine(() => false), 'x'),
      date: issues(z.date(), 'x'),
      invalidDate: issues(z.date(), new Date('x')),
      coerceNumber: issues(z.coerce.number(), 'abc'),
      boolean: issues(z.boolean(), 'yes'),
      nullType: issues(z.string(), null),
      arrayType: issues(z.string(), []),
      objectType: issues(z.string(), {}),
      nan: issues(z.number(), NaN),
    }).toMatchSnapshot();
  });
});
