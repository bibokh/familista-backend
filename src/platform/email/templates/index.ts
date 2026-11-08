// Invitation emails — the official languages, one design, no secrets
// ─────────────────────────────────────────────────────────────────────────────
// Familista's interface reads every locale in the registry. Its transactional
// email speaks the official languages only, deliberately — the set the
// registry (src/i18n/locales.ts) marks `official`, the same set every owner
// room speaks. A template is a piece of engineering with a layout and a
// right-to-left variant, not a catalogue entry, so each one here is written
// and reviewed, and a test fails when an official language has no copy.
//
// What is never in one of these:
//
//   · a password, or any instruction to use one somebody else chose
//   · a tokenHash, a refresh token, a database id nobody needs
//   · anything sensitive in the subject line — a subject appears in a
//     notification on a lock screen, which is a public place
//
// The raw acceptance token appears in exactly one place: inside the link, in
// the body. It is not in the subject, not in the plain-text preamble, and it
// exists in this process only long enough to be rendered.

import { OFFICIAL_LOCALES, localeDir } from '../../../i18n/locales';

/** The language subtag of an official locale — the key the copy below is written under. */
export type EmailLocale = 'en' | 'de' | 'ar' | 'fr' | 'es';

const subtagOf = (tag: string): string => tag.toLowerCase().split(/[-_]/)[0];

/** The registry tag an email is dated and directed by — "de" → "de-DE". */
const officialTag = (locale: EmailLocale): string =>
  OFFICIAL_LOCALES.find((l) => subtagOf(l.tag) === locale)?.tag ?? 'en-GB';

/**
 * Which language to write in.
 *
 *   1. the recipient's own, when the invitation or the account records one
 *   2. the club's default, when it has one
 *   3. English
 *
 * A tag is matched on its language subtag, so "de-AT" and "de-DE" are both
 * German — a template in the right language beats no template in the exactly
 * right region.
 */
export function resolveEmailLocale(...candidates: Array<string | null | undefined>): EmailLocale {
  for (const candidate of candidates) {
    const tag = String(candidate ?? '').trim().toLowerCase();
    if (!tag) continue;
    const primary = tag.split(/[-_]/)[0];
    if ((EMAIL_LOCALES as string[]).includes(primary)) return primary as EmailLocale;
  }
  return 'en';
}

export const isRtl = (locale: EmailLocale): boolean => localeDir(officialTag(locale)) === 'rtl';

export interface InvitationEmailContext {
  /** The person's name when the inviter gave one; the address is never the name. */
  recipientName?: string | null;
  clubName: string;
  /** A human phrase, already localised — "President", "Head Coach". */
  roleLabel: string;
  /**
   * What the role reaches: the teams by name, or the whole club.
   *
   * Written into the email because it is the half of an offer that decides
   * what the job is. "Head Coach" alone does not tell somebody whether they
   * were hired for the first team or the under-13s.
   */
  accessLabel?: string | null;
  /** Who is inviting, as a name or an organisation. Never an email address. */
  inviterName?: string | null;
  acceptUrl: string;
  expiresAt: Date;
  locale: EmailLocale;
  /** True for the resend, which says plainly that the old link has stopped working. */
  resent?: boolean;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  locale: EmailLocale;
}

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]);

const dateFor = (locale: EmailLocale, at: Date): string => {
  try {
    return new Intl.DateTimeFormat(
      officialTag(locale),
      { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' },
    ).format(at) + ' UTC';
  } catch {
    return at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
};

interface Copy {
  subjectPresident: (club: string) => string;
  subjectStaff: (club: string) => string;
  subjectResent: (club: string) => string;
  greeting: (name: string | null) => string;
  invitedPresident: (club: string, inviter: string | null) => string;
  invitedStaff: (club: string, role: string, inviter: string | null) => string;
  resentNotice: string;
  ownAccount: string;
  cta: string;
  fallbackIntro: string;
  expires: (when: string) => string;
  ignore: string;
  roleLine: (role: string) => string;
  clubLine: (club: string) => string;
  /** Which teams, or the whole club. Named because a coach needs to know. */
  accessLine: (access: string) => string;
  accessWholeClub: string;
  footer: string;
  noPassword: string;
}

/**
 * The words, per language.
 *
 * Kept here rather than in the SYSTEM catalogue because an email is not the
 * interface: it is rendered once, on the server, into a document that must
 * stand alone in somebody's inbox weeks later.
 */
const COPY: Record<EmailLocale, Copy> = {
  en: {
    subjectPresident: (club) => `You have been invited to lead ${club} on Familista`,
    subjectStaff: (club) => `You have been invited to join ${club} on Familista`,
    subjectResent: (club) => `Your invitation to ${club} on Familista`,
    greeting: (name) => (name ? `Hello ${name},` : 'Hello,'),
    invitedPresident: (club, inviter) =>
      `${inviter ? `${inviter} has invited you` : 'You have been invited'} to become the president of <strong>${club}</strong> on Familista.`,
    invitedStaff: (club, role, inviter) =>
      `${inviter ? `${inviter} has invited you` : 'You have been invited'} to join <strong>${club}</strong> on Familista as <strong>${role}</strong>.`,
    resentNotice: 'This is a new link. Any earlier invitation link for this address has stopped working.',
    ownAccount: 'You will sign in with your own Familista account and choose your own password. Nobody at the club, and nobody at Familista, can see it.',
    cta: 'Accept the invitation',
    fallbackIntro: 'If the button does not work, copy this address into your browser:',
    expires: (when) => `This invitation expires on ${when} and can be used once.`,
    ignore: 'If you were not expecting this, you can ignore it. Nothing happens until you accept.',
    roleLine: (role) => `Role: ${role}`,
    clubLine: (club) => `Club: ${club}`,
    accessLine: (access) => `Access: ${access}`,
    accessWholeClub: 'The whole club',
    footer: 'Familista — football connects the world',
    noPassword: 'Familista will never email you a password, and will never ask you for one by reply.',
  },
  de: {
    subjectPresident: (club) => `Sie wurden eingeladen, ${club} auf Familista zu leiten`,
    subjectStaff: (club) => `Sie wurden eingeladen, ${club} auf Familista beizutreten`,
    subjectResent: (club) => `Ihre Einladung zu ${club} auf Familista`,
    greeting: (name) => (name ? `Hallo ${name},` : 'Hallo,'),
    invitedPresident: (club, inviter) =>
      `${inviter ? `${inviter} hat Sie eingeladen` : 'Sie wurden eingeladen'}, Präsident von <strong>${club}</strong> auf Familista zu werden.`,
    invitedStaff: (club, role, inviter) =>
      `${inviter ? `${inviter} hat Sie eingeladen` : 'Sie wurden eingeladen'}, <strong>${club}</strong> auf Familista als <strong>${role}</strong> beizutreten.`,
    resentNotice: 'Dies ist ein neuer Link. Ein früherer Einladungslink für diese Adresse funktioniert nicht mehr.',
    ownAccount: 'Sie melden sich mit Ihrem eigenen Familista-Konto an und wählen Ihr eigenes Passwort. Niemand im Verein und niemand bei Familista kann es sehen.',
    cta: 'Einladung annehmen',
    fallbackIntro: 'Falls die Schaltfläche nicht funktioniert, kopieren Sie diese Adresse in Ihren Browser:',
    expires: (when) => `Diese Einladung läuft am ${when} ab und kann einmal verwendet werden.`,
    ignore: 'Wenn Sie das nicht erwartet haben, können Sie es ignorieren. Bis Sie annehmen, passiert nichts.',
    roleLine: (role) => `Rolle: ${role}`,
    clubLine: (club) => `Verein: ${club}`,
    accessLine: (access) => `Zugriff: ${access}`,
    accessWholeClub: 'Der gesamte Verein',
    footer: 'Familista — Fußball verbindet die Welt',
    noPassword: 'Familista sendet Ihnen niemals ein Passwort per E-Mail und fragt Sie niemals per Antwort danach.',
  },
  ar: {
    subjectPresident: (club) => `تمت دعوتك لرئاسة ${club} على فاميليستا`,
    subjectStaff: (club) => `تمت دعوتك للانضمام إلى ${club} على فاميليستا`,
    subjectResent: (club) => `دعوتك للانضمام إلى ${club} على فاميليستا`,
    greeting: (name) => (name ? `مرحباً ${name}،` : 'مرحباً،'),
    invitedPresident: (club, inviter) =>
      `${inviter ? `دعاك ${inviter}` : 'تمت دعوتك'} لتصبح رئيساً لنادي <strong>${club}</strong> على فاميليستا.`,
    invitedStaff: (club, role, inviter) =>
      `${inviter ? `دعاك ${inviter}` : 'تمت دعوتك'} للانضمام إلى <strong>${club}</strong> على فاميليستا بصفة <strong>${role}</strong>.`,
    resentNotice: 'هذا رابط جديد. أي رابط دعوة سابق لهذا العنوان لم يعد يعمل.',
    ownAccount: 'ستسجّل الدخول بحسابك الخاص على فاميليستا وتختار كلمة مرورك بنفسك. لا أحد في النادي ولا أحد في فاميليستا يستطيع رؤيتها.',
    cta: 'قبول الدعوة',
    fallbackIntro: 'إذا لم يعمل الزر، انسخ هذا العنوان إلى متصفحك:',
    expires: (when) => `تنتهي هذه الدعوة في ${when} ويمكن استخدامها مرة واحدة.`,
    ignore: 'إذا لم تكن تتوقع هذه الرسالة، يمكنك تجاهلها. لن يحدث شيء حتى تقبلها.',
    roleLine: (role) => `الدور: ${role}`,
    clubLine: (club) => `النادي: ${club}`,
    accessLine: (access) => `الوصول: ${access}`,
    accessWholeClub: 'النادي بأكمله',
    footer: 'فاميليستا — كرة القدم تجمع العالم',
    noPassword: 'لن ترسل لك فاميليستا كلمة مرور عبر البريد أبداً، ولن تطلبها منك في رد.',
  },
  fr: {
    subjectPresident: (club) => `Invitation à diriger ${club} sur Familista`,
    subjectStaff: (club) => `Invitation à rejoindre ${club} sur Familista`,
    subjectResent: (club) => `Votre invitation à rejoindre ${club} sur Familista`,
    greeting: (name) => (name ? `Bonjour ${name},` : 'Bonjour,'),
    invitedPresident: (club, inviter) =>
      `${inviter ? `${inviter} vous invite` : 'Vous recevez une invitation'} à présider <strong>${club}</strong> sur Familista.`,
    invitedStaff: (club, role, inviter) =>
      `${inviter ? `${inviter} vous invite` : 'Vous recevez une invitation'} à rejoindre <strong>${club}</strong> sur Familista en tant que <strong>${role}</strong>.`,
    resentNotice: 'Ceci est un nouveau lien. Tout lien d’invitation précédent pour cette adresse ne fonctionne plus.',
    ownAccount: 'Vous vous connecterez avec votre propre compte Familista et choisirez votre propre mot de passe. Personne au club, ni chez Familista, ne peut le voir.',
    cta: 'Accepter l’invitation',
    fallbackIntro: 'Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :',
    expires: (when) => `Cette invitation expire le ${when} et ne peut être utilisée qu’une seule fois.`,
    ignore: 'Si vous n’attendiez pas ce message, vous pouvez l’ignorer. Rien ne se passe tant que vous n’acceptez pas.',
    roleLine: (role) => `Rôle : ${role}`,
    clubLine: (club) => `Club : ${club}`,
    accessLine: (access) => `Accès : ${access}`,
    accessWholeClub: 'Tout le club',
    footer: 'Familista — le football relie le monde',
    noPassword: 'Familista ne vous enverra jamais de mot de passe par e-mail et ne vous en demandera jamais en réponse.',
  },
  es: {
    subjectPresident: (club) => `Te han invitado a dirigir ${club} en Familista`,
    subjectStaff: (club) => `Te han invitado a unirte a ${club} en Familista`,
    subjectResent: (club) => `Tu invitación a ${club} en Familista`,
    greeting: (name) => (name ? `Hola, ${name}:` : 'Hola:'),
    invitedPresident: (club, inviter) =>
      `${inviter ? `${inviter} te ha invitado` : 'Te han invitado'} a presidir <strong>${club}</strong> en Familista.`,
    invitedStaff: (club, role, inviter) =>
      `${inviter ? `${inviter} te ha invitado` : 'Te han invitado'} a unirte a <strong>${club}</strong> en Familista como <strong>${role}</strong>.`,
    resentNotice: 'Este es un enlace nuevo. Cualquier enlace de invitación anterior para esta dirección ha dejado de funcionar.',
    ownAccount: 'Iniciarás sesión con tu propia cuenta de Familista y elegirás tu propia contraseña. Nadie del club, ni nadie de Familista, puede verla.',
    cta: 'Aceptar la invitación',
    fallbackIntro: 'Si el botón no funciona, copia esta dirección en tu navegador:',
    expires: (when) => `Esta invitación caduca el ${when} y solo puede usarse una vez.`,
    ignore: 'Si no esperabas este mensaje, puedes ignorarlo. No ocurre nada hasta que aceptes.',
    roleLine: (role) => `Función: ${role}`,
    clubLine: (club) => `Club: ${club}`,
    accessLine: (access) => `Acceso: ${access}`,
    accessWholeClub: 'Todo el club',
    footer: 'Familista — el fútbol une el mundo',
    noPassword: 'Familista nunca te enviará una contraseña por correo electrónico ni te la pedirá en una respuesta.',
  },
};

/**
 * The languages this file writes, in the registry's order: every official
 * language that has copy above. The list is the registry's, not a third one —
 * a test fails when an official language is added without its copy, rather
 * than letting it fall through to English unnoticed.
 */
export const EMAIL_LOCALES: EmailLocale[] = OFFICIAL_LOCALES
  .map((l) => subtagOf(l.tag))
  .filter((code): code is EmailLocale => Object.prototype.hasOwnProperty.call(COPY, code));

/**
 * The shell every Familista email is drawn in.
 *
 * Table-free, inline-styled where it matters, and `dir` set from the locale so
 * an Arabic message reads right to left in every client — including the ones
 * that ignore CSS. `lang` is set for the same reason a page sets it.
 */
function shell(locale: EmailLocale, title: string, body: string): string {
  const dir = isRtl(locale) ? 'rtl' : 'ltr';
  const align = isRtl(locale) ? 'right' : 'left';
  return `<!DOCTYPE html>
<html lang="${locale}" dir="${dir}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#070b14;">
  <div dir="${dir}" style="max-width:560px;margin:32px auto;background:#111a2c;border:1px solid rgba(255,255,255,.08);border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;text-align:${align};">
    <div style="padding:28px 36px 22px;border-bottom:1px solid rgba(255,255,255,.07);text-align:center;">
      <div style="font-size:22px;font-weight:800;letter-spacing:-.4px;color:#e9eefb;">Famili<span style="color:#3b82f6;">sta</span></div>
    </div>
    <div style="padding:32px 36px;color:#c3ccdf;font-size:15px;line-height:1.65;">
${body}
    </div>
    <div style="padding:20px 36px;border-top:1px solid rgba(255,255,255,.07);text-align:center;font-size:11px;color:#67718c;">
      ${esc(COPY[locale].footer)}
    </div>
  </div>
</body>
</html>`;
}

function button(locale: EmailLocale, url: string, label: string): string {
  return `<div style="text-align:center;margin:28px 0;">
        <a href="${esc(url)}" style="display:inline-block;background:#3b82f6;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;padding:14px 30px;border-radius:10px;">${esc(label)}</a>
      </div>`;
}

function facts(locale: EmailLocale, ctx: InvitationEmailContext): string {
  const c = COPY[locale];
  return `<div style="background:rgba(255,255,255,.04);border-radius:10px;padding:14px 16px;margin:20px 0;font-size:13px;color:#98a3bd;">
        <div>${esc(c.clubLine(ctx.clubName))}</div>
        <div>${esc(c.roleLine(ctx.roleLabel))}</div>
        <div>${esc(c.accessLine(ctx.accessLabel?.trim() || c.accessWholeClub))}</div>
      </div>`;
}

/** The president's invitation, and the staff member's. Same shell, different sentence. */
export function renderInvitationEmail(
  kind: 'PRESIDENT' | 'STAFF',
  ctx: InvitationEmailContext,
): RenderedEmail {
  const locale = ctx.locale;
  const c = COPY[locale];
  const when = dateFor(locale, ctx.expiresAt);
  const name = ctx.recipientName?.trim() || null;
  const inviter = ctx.inviterName?.trim() || null;

  const opening = kind === 'PRESIDENT'
    ? c.invitedPresident(esc(ctx.clubName), inviter ? esc(inviter) : null)
    : c.invitedStaff(esc(ctx.clubName), esc(ctx.roleLabel), inviter ? esc(inviter) : null);

  // The subject names the club and nothing else. It appears on a lock screen.
  const subject = ctx.resent
    ? c.subjectResent(ctx.clubName)
    : kind === 'PRESIDENT' ? c.subjectPresident(ctx.clubName) : c.subjectStaff(ctx.clubName);

  const html = shell(locale, subject, `      <p style="margin:0 0 14px;">${esc(c.greeting(name))}</p>
      <p style="margin:0 0 14px;">${opening}</p>
${ctx.resent ? `      <p style="margin:0 0 14px;color:#fbbf24;">${esc(c.resentNotice)}</p>\n` : ''}${facts(locale, ctx)}
      <p style="margin:0 0 14px;">${esc(c.ownAccount)}</p>
${button(locale, ctx.acceptUrl, c.cta)}
      <p style="margin:0 0 8px;font-size:13px;color:#98a3bd;">${esc(c.fallbackIntro)}</p>
      <div style="background:#070b14;border-radius:8px;padding:12px 14px;font-size:12px;word-break:break-all;color:#8b96ad;direction:ltr;text-align:left;">${esc(ctx.acceptUrl)}</div>
      <p style="margin:18px 0 8px;font-size:13px;color:#98a3bd;">${esc(c.expires(when))}</p>
      <p style="margin:0 0 8px;font-size:13px;color:#98a3bd;">${esc(c.noPassword)}</p>
      <p style="margin:0;font-size:13px;color:#67718c;">${esc(c.ignore)}</p>`);

  const text = [
    c.greeting(name),
    '',
    opening.replace(/<[^>]+>/g, ''),
    ...(ctx.resent ? ['', c.resentNotice] : []),
    '',
    c.clubLine(ctx.clubName),
    c.roleLine(ctx.roleLabel),
    c.accessLine(ctx.accessLabel?.trim() || c.accessWholeClub),
    '',
    c.ownAccount,
    '',
    `${c.cta}: ${ctx.acceptUrl}`,
    '',
    c.expires(when),
    c.noPassword,
    '',
    c.ignore,
    '',
    `— ${c.footer}`,
  ].join('\n');

  return { subject, html, text, locale };
}
