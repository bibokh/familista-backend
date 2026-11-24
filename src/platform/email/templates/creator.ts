/**
 * Familista — the two emails a creator account receives (Creator Studio, P2): confirming the address, and resetting the
 * password. Written in every official locale, drawn in the same shell as every other Familista email. The link is the
 * only secret in either, and it is never logged: the delivery log carries the account's id.
 */
import { emailButton, emailEsc, emailShell, type EmailLocale, type RenderedEmail } from './index';

export type CreatorEmailKind = 'verify' | 'reset';

interface Copy { subject: string; title: string; lead: string; action: string; expiry: string; ignore: string }
const COPY: Record<EmailLocale, Record<CreatorEmailKind, Copy>> = {
  en: {
    verify: { subject: 'Confirm your Familista creator account', title: 'Confirm your email address', lead: 'Hello %s, confirm that this address is yours to finish setting up your Familista Creator Studio account.', action: 'Confirm email address', expiry: 'This link works once and expires in 48 hours.', ignore: 'If you did not open a Familista creator account, ignore this email.' },
    reset: { subject: 'Reset your Familista creator password', title: 'Reset your password', lead: 'Hello %s, a new password was requested for your Familista Creator Studio account.', action: 'Choose a new password', expiry: 'This link works once and expires in one hour.', ignore: 'If you did not ask for this, ignore this email: your password stays as it is.' },
  },
  de: {
    verify: { subject: 'Bestätigen Sie Ihr Familista-Creator-Konto', title: 'E-Mail-Adresse bestätigen', lead: 'Hallo %s, bestätigen Sie, dass diese Adresse Ihnen gehört, um Ihr Konto im Familista Creator Studio fertig einzurichten.', action: 'E-Mail-Adresse bestätigen', expiry: 'Dieser Link funktioniert einmal und läuft in 48 Stunden ab.', ignore: 'Wenn Sie kein Familista-Creator-Konto eröffnet haben, ignorieren Sie diese E-Mail.' },
    reset: { subject: 'Familista-Creator-Passwort zurücksetzen', title: 'Passwort zurücksetzen', lead: 'Hallo %s, für Ihr Konto im Familista Creator Studio wurde ein neues Passwort angefordert.', action: 'Neues Passwort wählen', expiry: 'Dieser Link funktioniert einmal und läuft in einer Stunde ab.', ignore: 'Wenn Sie das nicht angefordert haben, ignorieren Sie diese E-Mail: Ihr Passwort bleibt unverändert.' },
  },
  fr: {
    verify: { subject: 'Confirmez votre compte créateur Familista', title: 'Confirmez votre adresse e-mail', lead: 'Bonjour %s, confirmez que cette adresse est bien la vôtre pour terminer la création de votre compte Familista Creator Studio.', action: 'Confirmer l’adresse e-mail', expiry: 'Ce lien ne fonctionne qu’une fois et expire dans 48 heures.', ignore: 'Si vous n’avez pas ouvert de compte créateur Familista, ignorez cet e-mail.' },
    reset: { subject: 'Réinitialisez votre mot de passe créateur Familista', title: 'Réinitialiser votre mot de passe', lead: 'Bonjour %s, un nouveau mot de passe a été demandé pour votre compte Familista Creator Studio.', action: 'Choisir un nouveau mot de passe', expiry: 'Ce lien ne fonctionne qu’une fois et expire dans une heure.', ignore: 'Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail : votre mot de passe reste inchangé.' },
  },
  es: {
    verify: { subject: 'Confirma tu cuenta de creador de Familista', title: 'Confirma tu dirección de correo', lead: 'Hola %s, confirma que esta dirección es tuya para terminar de configurar tu cuenta de Familista Creator Studio.', action: 'Confirmar la dirección de correo', expiry: 'Este enlace funciona una sola vez y caduca en 48 horas.', ignore: 'Si no has abierto una cuenta de creador de Familista, ignora este correo.' },
    reset: { subject: 'Restablece tu contraseña de creador de Familista', title: 'Restablecer tu contraseña', lead: 'Hola %s, se ha solicitado una contraseña nueva para tu cuenta de Familista Creator Studio.', action: 'Elegir una contraseña nueva', expiry: 'Este enlace funciona una sola vez y caduca en una hora.', ignore: 'Si no lo has solicitado, ignora este correo: tu contraseña sigue siendo la misma.' },
  },
  ar: {
    verify: { subject: 'أكّد حساب المصمّم في Familista', title: 'أكّد عنوان بريدك الإلكتروني', lead: 'مرحبًا %s، أكّد أن هذا العنوان لك لإكمال إعداد حسابك في Familista Creator Studio.', action: 'تأكيد عنوان البريد الإلكتروني', expiry: 'يعمل هذا الرابط مرة واحدة وتنتهي صلاحيته خلال 48 ساعة.', ignore: 'إذا لم تفتح حساب مصمّم في Familista، فتجاهل هذه الرسالة.' },
    reset: { subject: 'أعد تعيين كلمة مرور حساب المصمّم في Familista', title: 'إعادة تعيين كلمة المرور', lead: 'مرحبًا %s، طُلبت كلمة مرور جديدة لحسابك في Familista Creator Studio.', action: 'اختيار كلمة مرور جديدة', expiry: 'يعمل هذا الرابط مرة واحدة وتنتهي صلاحيته خلال ساعة واحدة.', ignore: 'إذا لم تطلب ذلك، فتجاهل هذه الرسالة: تبقى كلمة مرورك كما هي.' },
  },
};

export function renderCreatorEmail(kind: CreatorEmailKind, locale: EmailLocale, ctx: { name: string; url: string }): RenderedEmail {
  const c = COPY[locale][kind];
  const lead = c.lead.replace('%s', ctx.name);
  const body = `      <h1 style="margin:0 0 14px;font-size:20px;color:#e9eefb;">${emailEsc(c.title)}</h1>
      <p style="margin:0 0 8px;">${emailEsc(lead)}</p>
      ${emailButton(locale, ctx.url, c.action)}
      <p style="margin:0 0 8px;font-size:13px;color:#98a3bd;">${emailEsc(c.expiry)}</p>
      <p style="margin:0;font-size:13px;color:#98a3bd;">${emailEsc(c.ignore)}</p>`;
  return {
    subject: c.subject, locale,
    html: emailShell(locale, c.title, body),
    text: [c.title, '', lead, '', `${c.action}: ${ctx.url}`, '', c.expiry, c.ignore].join('\n'),
  } as RenderedEmail;
}
