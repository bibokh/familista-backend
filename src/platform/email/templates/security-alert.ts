// Security alert and daily digest emails — to the platform operator (R6)
// ─────────────────────────────────────────────────────────────────────────────
// The same official languages as every Familista transactional email (see
// templates/index.ts — right-to-left where the registry says so), and the same
// rules:
//
//   · nothing sensitive in the subject — it shows on a lock screen. The
//     subject says an alert exists, never what it is about.
//   · counts, rule names and time windows only. No IP address, no user or
//     club id, no email address, no event payload: the operator opens the
//     owner security view to see the rows, behind their own sign-in.

import { EMAIL_LOCALES, isRtl, type EmailLocale } from './index';

/** The operator's language: one of the official languages the email templates write. */
export type AlertLocale = EmailLocale;

export function resolveAlertLocale(tag: string | null | undefined): AlertLocale {
  const primary = String(tag ?? '').toLowerCase().split(/[-_]/)[0];
  return (EMAIL_LOCALES as string[]).includes(primary) ? (primary as AlertLocale) : 'en';
}

export interface AlertLine {
  /** A rule id from security-alerts.ts — a fixed word, never data. */
  rule: string;
  count: number;
  /** Signals of the same rule held back by the de-duplication window since the last email. */
  suppressed: number;
}

/** A rule id and how many of its signals were recorded in the last 24 hours. */
export interface DigestLine { rule: string; count: number }

interface Copy {
  alertSubject: string;
  digestSubject: string;
  alertHeading: string;
  digestHeading: string;
  alertIntro: (minutes: number) => string;
  digestIntro: string;
  held: (n: number) => string;
  backup: (hours: number | null) => string;
  nothing: string;
  open: string;
  footer: string;
  rules: Record<string, string>;
}

const COPY: Record<AlertLocale, Copy> = {
  en: {
    alertSubject: 'Familista security alert',
    digestSubject: 'Familista security digest',
    alertHeading: 'Security signals need your attention',
    digestHeading: 'Security summary, last 24 hours',
    alertIntro: (m) => `New signals in the last ${m} minutes:`,
    digestIntro: 'Recorded security signals by kind:',
    held: (n) => `${n} more held back to avoid repeated emails`,
    backup: (h) => (h === null ? 'No successful backup is recorded.' : `Last successful backup: ${h} hours ago.`),
    nothing: 'No security signals were recorded.',
    open: 'Open the security view in Familista, signed in as the platform owner, to see the details.',
    footer: 'Sent to the address in SECURITY_ALERT_EMAIL. No personal data, addresses or identifiers are included in this email.',
    rules: {
      'critical-event': 'Critical security events',
      'tenant-mismatch': 'Attempts to reach another club\'s data',
      'audit-chain-broken': 'Audit chain verification failed',
      'login-locked': 'Accounts locked after repeated failed sign-ins',
      'refresh-token-reuse': 'A refresh token was reused (possible stolen session)',
      'brute-force': 'Sign-in attempts that would trigger the lockout',
      'backup-failed': 'A scheduled backup failed',
      'backup-stale': 'No successful backup in the last 36 hours',
    },
  },
  de: {
    alertSubject: 'Familista Sicherheitswarnung',
    digestSubject: 'Familista Sicherheitsübersicht',
    alertHeading: 'Sicherheitssignale erfordern Ihre Aufmerksamkeit',
    digestHeading: 'Sicherheitsübersicht der letzten 24 Stunden',
    alertIntro: (m) => `Neue Signale in den letzten ${m} Minuten:`,
    digestIntro: 'Erfasste Sicherheitssignale nach Art:',
    held: (n) => `${n} weitere zurückgehalten, um wiederholte E-Mails zu vermeiden`,
    backup: (h) => (h === null ? 'Es ist keine erfolgreiche Sicherung erfasst.' : `Letzte erfolgreiche Sicherung: vor ${h} Stunden.`),
    nothing: 'Es wurden keine Sicherheitssignale erfasst.',
    open: 'Öffnen Sie die Sicherheitsansicht in Familista, angemeldet als Plattformbetreiber, um die Details zu sehen.',
    footer: 'Gesendet an die Adresse in SECURITY_ALERT_EMAIL. Diese E-Mail enthält keine personenbezogenen Daten, Adressen oder Kennungen.',
    rules: {
      'critical-event': 'Kritische Sicherheitsereignisse',
      'tenant-mismatch': 'Zugriffsversuche auf Daten eines anderen Vereins',
      'audit-chain-broken': 'Prüfung der Audit-Kette fehlgeschlagen',
      'login-locked': 'Konten nach wiederholten Fehlanmeldungen gesperrt',
      'refresh-token-reuse': 'Ein Refresh-Token wurde erneut verwendet (mögliche gestohlene Sitzung)',
      'brute-force': 'Anmeldeversuche, die die Sperre auslösen würden',
      'backup-failed': 'Eine geplante Sicherung ist fehlgeschlagen',
      'backup-stale': 'Keine erfolgreiche Sicherung in den letzten 36 Stunden',
    },
  },
  ar: {
    alertSubject: 'تنبيه أمني من Familista',
    digestSubject: 'ملخص أمني من Familista',
    alertHeading: 'إشارات أمنية تتطلب انتباهك',
    digestHeading: 'ملخص أمني لآخر 24 ساعة',
    alertIntro: (m) => `إشارات جديدة خلال آخر ${m} دقيقة:`,
    digestIntro: 'الإشارات الأمنية المسجلة حسب النوع:',
    held: (n) => `تم حجب ${n} إشارة إضافية لتجنب تكرار الرسائل`,
    backup: (h) => (h === null ? 'لا توجد نسخة احتياطية ناجحة مسجلة.' : `آخر نسخة احتياطية ناجحة: قبل ${h} ساعة.`),
    nothing: 'لم تُسجل أي إشارات أمنية.',
    open: 'افتح العرض الأمني في Familista بعد تسجيل الدخول كمالك للمنصة لرؤية التفاصيل.',
    footer: 'أُرسلت إلى العنوان المحدد في SECURITY_ALERT_EMAIL. لا تتضمن هذه الرسالة أي بيانات شخصية أو عناوين أو معرّفات.',
    rules: {
      'critical-event': 'أحداث أمنية حرجة',
      'tenant-mismatch': 'محاولات للوصول إلى بيانات نادٍ آخر',
      'audit-chain-broken': 'فشل التحقق من سلسلة التدقيق',
      'login-locked': 'حسابات مقفلة بعد محاولات تسجيل دخول فاشلة متكررة',
      'refresh-token-reuse': 'أُعيد استخدام رمز تحديث (جلسة مسروقة محتملة)',
      'brute-force': 'محاولات تسجيل دخول كانت ستؤدي إلى القفل',
      'backup-failed': 'فشلت نسخة احتياطية مجدولة',
      'backup-stale': 'لا توجد نسخة احتياطية ناجحة خلال آخر 36 ساعة',
    },
  },
  fr: {
    alertSubject: 'Alerte de sécurité Familista',
    digestSubject: 'Synthèse de sécurité Familista',
    alertHeading: 'Des signaux de sécurité requièrent votre attention',
    digestHeading: 'Synthèse de sécurité des dernières 24 heures',
    alertIntro: (m) => `Nouveaux signaux au cours des ${m} dernières minutes :`,
    digestIntro: 'Signaux de sécurité enregistrés, par type :',
    held: (n) => `${n} de plus retenus pour éviter des e-mails répétés`,
    backup: (h) => (h === null ? 'Aucune sauvegarde réussie n’est enregistrée.' : `Dernière sauvegarde réussie : il y a ${h} heures.`),
    nothing: 'Aucun signal de sécurité n’a été enregistré.',
    open: 'Ouvrez la vue de sécurité dans Familista, connecté en tant que propriétaire de la plateforme, pour voir le détail.',
    footer: 'Envoyé à l’adresse définie dans SECURITY_ALERT_EMAIL. Cet e-mail ne contient aucune donnée personnelle, adresse ou identifiant.',
    rules: {
      'critical-event': 'Événements de sécurité critiques',
      'tenant-mismatch': 'Tentatives d’accès aux données d’un autre club',
      'audit-chain-broken': 'Échec de la vérification de la chaîne d’audit',
      'login-locked': 'Comptes verrouillés après des échecs de connexion répétés',
      'refresh-token-reuse': 'Un jeton d’actualisation a été réutilisé (session possiblement volée)',
      'brute-force': 'Tentatives de connexion qui déclencheraient le verrouillage',
      'backup-failed': 'Une sauvegarde planifiée a échoué',
      'backup-stale': 'Aucune sauvegarde réussie au cours des 36 dernières heures',
    },
  },
  es: {
    alertSubject: 'Alerta de seguridad de Familista',
    digestSubject: 'Resumen de seguridad de Familista',
    alertHeading: 'Hay señales de seguridad que requieren tu atención',
    digestHeading: 'Resumen de seguridad de las últimas 24 horas',
    alertIntro: (m) => `Nuevas señales en los últimos ${m} minutos:`,
    digestIntro: 'Señales de seguridad registradas por tipo:',
    held: (n) => `${n} más retenidas para evitar correos repetidos`,
    backup: (h) => (h === null ? 'No hay ninguna copia de seguridad correcta registrada.' : `Última copia de seguridad correcta: hace ${h} horas.`),
    nothing: 'No se registró ninguna señal de seguridad.',
    open: 'Abre la vista de seguridad en Familista, con la sesión iniciada como propietario de la plataforma, para ver los detalles.',
    footer: 'Enviado a la dirección configurada en SECURITY_ALERT_EMAIL. Este correo no incluye datos personales, direcciones ni identificadores.',
    rules: {
      'critical-event': 'Eventos de seguridad críticos',
      'tenant-mismatch': 'Intentos de acceder a los datos de otro club',
      'audit-chain-broken': 'Falló la verificación de la cadena de auditoría',
      'login-locked': 'Cuentas bloqueadas tras inicios de sesión fallidos repetidos',
      'refresh-token-reuse': 'Se reutilizó un token de actualización (posible sesión robada)',
      'brute-force': 'Intentos de inicio de sesión que activarían el bloqueo',
      'backup-failed': 'Falló una copia de seguridad programada',
      'backup-stale': 'Ninguna copia de seguridad correcta en las últimas 36 horas',
    },
  },
};

const esc = (v: unknown): string =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function shell(locale: AlertLocale, title: string, body: string): string {
  const dir = isRtl(locale) ? 'rtl' : 'ltr';
  const align = isRtl(locale) ? 'right' : 'left';
  return `<!doctype html>
<html lang="${locale}" dir="${dir}">
<head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="margin:0;padding:24px;background:#0b0f14;color:#e6edf3;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:${align}">
  <div style="max-width:560px;margin:0 auto;background:#111821;border:1px solid #233142;border-radius:16px;padding:24px">
    <h1 style="margin:0 0 16px;font-size:18px;color:#f5b041">${esc(title)}</h1>
    ${body}
    <p style="margin:24px 0 0;font-size:12px;color:#8b98a5">${esc(COPY[locale].footer)}</p>
  </div>
</body>
</html>`;
}

const ruleLabel = (locale: AlertLocale, rule: string): string => COPY[locale].rules[rule] ?? rule;

export interface RenderedAlert { subject: string; html: string; text: string; locale: AlertLocale }

export function renderSecurityAlert(locale: AlertLocale, lines: AlertLine[], windowMinutes: number): RenderedAlert {
  const c = COPY[locale];
  const rows = lines.map((l) => {
    const held = l.suppressed > 0 ? ` — ${c.held(l.suppressed)}` : '';
    return { html: `<li style="margin:4px 0"><strong>${esc(l.count)}</strong> × ${esc(ruleLabel(locale, l.rule))}${esc(held)}</li>`, text: `- ${l.count} × ${ruleLabel(locale, l.rule)}${held}` };
  });
  const body = `<p>${esc(c.alertIntro(windowMinutes))}</p><ul style="padding-${isRtl(locale) ? 'right' : 'left'}:20px">${rows.map((r) => r.html).join('')}</ul><p>${esc(c.open)}</p>`;
  const text = [c.alertHeading, '', c.alertIntro(windowMinutes), ...rows.map((r) => r.text), '', c.open, '', c.footer].join('\n');
  return { subject: c.alertSubject, html: shell(locale, c.alertHeading, body), text, locale };
}

export function renderSecurityDigest(locale: AlertLocale, lines: DigestLine[], hoursSinceBackup: number | null): RenderedAlert {
  const c = COPY[locale];
  const nonZero = lines.filter((l) => l.count > 0);
  const list = nonZero.length
    ? `<ul style="padding-${isRtl(locale) ? 'right' : 'left'}:20px">${nonZero.map((l) => `<li style="margin:4px 0"><strong>${esc(l.count)}</strong> × ${esc(ruleLabel(locale, l.rule))}</li>`).join('')}</ul>`
    : `<p>${esc(c.nothing)}</p>`;
  const body = `<p>${esc(c.digestIntro)}</p>${list}<p>${esc(c.backup(hoursSinceBackup))}</p><p>${esc(c.open)}</p>`;
  const text = [c.digestHeading, '', c.digestIntro, ...(nonZero.length ? nonZero.map((l) => `- ${l.count} × ${ruleLabel(locale, l.rule)}`) : [c.nothing]), '', c.backup(hoursSinceBackup), '', c.open, '', c.footer].join('\n');
  return { subject: c.digestSubject, html: shell(locale, c.digestHeading, body), text, locale };
}

/** The rule ids a rendered alert can name (for tests and the posture scanner). */
export const ALERT_RULE_IDS = Object.keys(COPY.en.rules);
