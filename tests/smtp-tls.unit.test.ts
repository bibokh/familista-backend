/**
 * tests/smtp-tls.unit.test.ts
 *
 * Cyber Defense, R12 — mail and SMTP credentials never cross the network in
 * the clear: STARTTLS is required on every non-465 port, the certificate is
 * verified, and nothing below TLS 1.2 is accepted.
 */

const createTransport = jest.fn(() => ({ sendMail: jest.fn().mockResolvedValue({ messageId: 'm1' }) }));
jest.mock('nodemailer', () => ({ createTransport }), { virtual: true });

import { SmtpProvider } from '../src/platform/email/providers/smtp';

describe('the SMTP transport', () => {
  it('requires TLS, verifies the certificate and refuses old protocol versions', async () => {
    const res = await new SmtpProvider().send({ to: { address: 'x@club.test' }, subject: 's', text: 't', html: '<p>t</p>' } as never, 5000);
    expect(res.ok).toBe(true);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport.mock.calls[0]).toEqual([expect.objectContaining({
      requireTLS: true,
      tls: expect.objectContaining({ minVersion: 'TLSv1.2', rejectUnauthorized: true }),
    })]);
  });
});
