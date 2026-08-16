import { useCallback } from 'react';
import { useLocale } from 'twenty-sdk/front-component';

/**
 * Every word a user reads (FR-UI-5, specs/01 §7).
 *
 * The server answers in machine codes — `WINDOW_CLOSED`, `131026`, `NO_CONSENT`
 * — and never in sentences. That is what makes this file possible: rewording a
 * denial, or having counsel change the phrasing of a consent notice, is an edit
 * here and not a deploy of the send path.
 *
 * Written pt-first and translated to en, not the reverse. The users are
 * Portuguese-speaking (A-6), and a Portuguese string that reads like a
 * translation of English is the tell that nobody who speaks it wrote it.
 */

export type Lang = 'pt' | 'en';

export const langOf = (locale: string | null | undefined): Lang =>
  typeof locale === 'string' && locale.toLowerCase().startsWith('pt') ? 'pt' : 'en';

type Table = Record<string, string>;

const PT: Table = {
  // Policy denials — the composer's disabled states (specs/08 §3.3).
  'policy.ACCOUNT_NOT_CONNECTED': 'O número de WhatsApp não está ligado.',
  'policy.THREAD_BLOCKED': 'Esta conversa está bloqueada.',
  'policy.OPTED_OUT': 'Este contacto cancelou a subscrição.',
  'policy.NO_CONSENT': 'Este contacto não deu consentimento para marketing.',
  'policy.WINDOW_CLOSED':
    'A janela de 24 horas fechou. Só pode enviar um modelo aprovado.',
  'policy.TEMPLATE_UNAVAILABLE': 'Este modelo não está disponível para envio.',
  'policy.QUALITY_RED': 'A qualidade do número está em vermelho.',

  'warning.WINDOW_EXPIRING_SOON': 'A janela fecha em breve.',
  'warning.CONSENT_UNKNOWN_MARKETING': 'Sem consentimento registado para marketing.',
  'warning.QUALITY_YELLOW': 'A qualidade do número está em amarelo.',

  // Message states.
  'status.QUEUED': 'Em fila',
  'status.ACCEPTED': 'Aceite',
  'status.SENT': 'Enviada',
  'status.DELIVERED': 'Entregue',
  'status.READ': 'Lida',
  'status.PLAYED': 'Ouvida',
  'status.FAILED': 'Falhou',

  'thread.OPEN': 'Aberta',
  'thread.AWAITING_REPLY': 'À espera de resposta',
  'thread.CLOSED': 'Fechada',
  'thread.NEEDS_REVIEW': 'Por identificar',

  'consent.OPTED_IN': 'Subscrito',
  'consent.OPTED_OUT': 'Cancelou',
  'consent.UNKNOWN': 'Sem registo',

  // The Meta errors a rep can actually see on a bubble (appendix B).
  'error.131047': 'Fora da janela de 24 horas — use um modelo.',
  'error.131026': 'Este número não está no WhatsApp.',
  'error.131049': 'A Meta limitou as mensagens de marketing para este contacto hoje.',
  'error.131000': 'Erro temporário da Meta.',
  'error.130429': 'Limite de envio atingido — tente novamente.',
  'error.132000': 'O modelo não corresponde às variáveis enviadas.',
  'error.132001': 'O modelo não existe ou não está aprovado.',
  'error.132012': 'Um valor de variável foi recusado pela Meta.',
  'error.133010': 'O número não está registado na Meta.',
  'error.POLICY_WINDOW_CLOSED': 'A janela fechou antes do envio.',
  'error.POLICY_OPTED_OUT': 'O contacto cancelou a subscrição antes do envio.',
  'error.POLICY_TEMPLATE_UNAVAILABLE': 'O modelo deixou de estar disponível.',
  'error.POLICY_ACCOUNT_ERROR': 'O número deixou de estar ligado.',
  'error.UNKNOWN_ACCEPTANCE': 'Resultado desconhecido — verifique antes de reenviar.',
  'error.MEDIA_TOO_LARGE': 'O ficheiro excede o limite da Meta.',
  'error.MEDIA_UNAVAILABLE': 'O ficheiro já não está disponível na Meta.',
  'error.CANCELLED': 'Cancelada.',
  'error.INTERNAL_TIMEOUT': 'Tempo esgotado.',
  'error.CONFIG_MISSING': 'Configuração em falta.',
  'error.unknown': 'Erro não catalogado.',

  // Campaign exclusions (specs/07).
  'exclusion.OPTED_OUT': 'Cancelou a subscrição',
  'exclusion.NO_CONSENT': 'Sem consentimento',
  'exclusion.INVALID_PHONE': 'Número inválido',
  'exclusion.DUPLICATE': 'Duplicado',
  'exclusion.MISSING_VARIABLES': 'Variáveis em falta',
  'exclusion.BLOCKED': 'Conversa bloqueada',

  // Chat chrome.
  'chat.windowOpen': 'Janela aberta',
  'chat.windowClosed': 'Janela fechada',
  'chat.closesIn': 'fecha em {time}',
  'chat.loadOlder': 'Carregar mensagens anteriores',
  'chat.empty': 'Ainda não há mensagens nesta conversa.',
  'chat.noThread': 'Este contacto ainda não tem conversa de WhatsApp.',
  'chat.start': 'Iniciar conversa',
  'chat.placeholder': 'Escreva uma mensagem',
  'chat.send': 'Enviar',
  'chat.chooseTemplate': 'Escolher modelo',
  'chat.retry': 'Repetir',
  'chat.details': 'Ver detalhes',
  'chat.voiceNote': 'Mensagem de voz',
  'chat.download': 'Transferir ({size})',
  'chat.unsupported': 'Mensagem não suportada',
  'chat.today': 'Hoje',
  'chat.yesterday': 'Ontem',
  'chat.reconnect': 'Retomar actualizações',
  'chat.suspended': 'Actualizações em pausa.',
  'chat.offline': 'Sem ligação ao servidor.',
  'chat.sending': 'A enviar…',
  'chat.campaign': 'Campanha',
  'chat.template': 'Modelo',
  'chat.needsReview': 'Por identificar',
  'chat.blocked': 'Bloqueada',
  'chat.testAccount': 'Número de teste',
  'chat.qualityYellow': 'Qualidade do número: amarelo',
  'chat.qualityRed': 'Qualidade do número: vermelho',
  'chat.accountError': 'O número de WhatsApp não está ligado.',
};

const EN: Table = {
  'policy.ACCOUNT_NOT_CONNECTED': 'The WhatsApp number is not connected.',
  'policy.THREAD_BLOCKED': 'This conversation is blocked.',
  'policy.OPTED_OUT': 'This contact has unsubscribed.',
  'policy.NO_CONSENT': 'This contact has not consented to marketing.',
  'policy.WINDOW_CLOSED': 'The 24-hour window has closed. Only an approved template can be sent.',
  'policy.TEMPLATE_UNAVAILABLE': 'This template is not available to send.',
  'policy.QUALITY_RED': 'The number’s quality rating is red.',

  'warning.WINDOW_EXPIRING_SOON': 'The window closes soon.',
  'warning.CONSENT_UNKNOWN_MARKETING': 'No recorded marketing consent.',
  'warning.QUALITY_YELLOW': 'The number’s quality rating is yellow.',

  'status.QUEUED': 'Queued',
  'status.ACCEPTED': 'Accepted',
  'status.SENT': 'Sent',
  'status.DELIVERED': 'Delivered',
  'status.READ': 'Read',
  'status.PLAYED': 'Played',
  'status.FAILED': 'Failed',

  'thread.OPEN': 'Open',
  'thread.AWAITING_REPLY': 'Awaiting reply',
  'thread.CLOSED': 'Closed',
  'thread.NEEDS_REVIEW': 'Unidentified',

  'consent.OPTED_IN': 'Subscribed',
  'consent.OPTED_OUT': 'Unsubscribed',
  'consent.UNKNOWN': 'No record',

  'error.131047': 'Outside the 24-hour window — use a template.',
  'error.131026': 'This number is not on WhatsApp.',
  'error.131049': 'Meta capped marketing messages to this contact today.',
  'error.131000': 'Temporary Meta error.',
  'error.130429': 'Send limit reached — try again.',
  'error.132000': 'The template does not match the variables sent.',
  'error.132001': 'The template does not exist or is not approved.',
  'error.132012': 'Meta rejected a variable value.',
  'error.133010': 'The number is not registered with Meta.',
  'error.POLICY_WINDOW_CLOSED': 'The window closed before the message was sent.',
  'error.POLICY_OPTED_OUT': 'The contact unsubscribed before the message was sent.',
  'error.POLICY_TEMPLATE_UNAVAILABLE': 'The template became unavailable.',
  'error.POLICY_ACCOUNT_ERROR': 'The number is no longer connected.',
  'error.UNKNOWN_ACCEPTANCE': 'Unknown outcome — check before resending.',
  'error.MEDIA_TOO_LARGE': 'The file exceeds Meta’s limit.',
  'error.MEDIA_UNAVAILABLE': 'The file is no longer available from Meta.',
  'error.CANCELLED': 'Cancelled.',
  'error.INTERNAL_TIMEOUT': 'Timed out.',
  'error.CONFIG_MISSING': 'Missing configuration.',
  'error.unknown': 'Uncatalogued error.',

  'exclusion.OPTED_OUT': 'Unsubscribed',
  'exclusion.NO_CONSENT': 'No consent',
  'exclusion.INVALID_PHONE': 'Invalid number',
  'exclusion.DUPLICATE': 'Duplicate',
  'exclusion.MISSING_VARIABLES': 'Missing variables',
  'exclusion.BLOCKED': 'Blocked conversation',

  'chat.windowOpen': 'Window open',
  'chat.windowClosed': 'Window closed',
  'chat.closesIn': 'closes in {time}',
  'chat.loadOlder': 'Load earlier messages',
  'chat.empty': 'No messages in this conversation yet.',
  'chat.noThread': 'This contact has no WhatsApp conversation yet.',
  'chat.start': 'Start a conversation',
  'chat.placeholder': 'Write a message',
  'chat.send': 'Send',
  'chat.chooseTemplate': 'Choose a template',
  'chat.retry': 'Retry',
  'chat.details': 'Show details',
  'chat.voiceNote': 'Voice message',
  'chat.download': 'Download ({size})',
  'chat.unsupported': 'Unsupported message',
  'chat.today': 'Today',
  'chat.yesterday': 'Yesterday',
  'chat.reconnect': 'Resume updates',
  'chat.suspended': 'Updates paused.',
  'chat.offline': 'No connection to the server.',
  'chat.sending': 'Sending…',
  'chat.campaign': 'Campaign',
  'chat.template': 'Template',
  'chat.needsReview': 'Unidentified',
  'chat.blocked': 'Blocked',
  'chat.testAccount': 'Test number',
  'chat.qualityYellow': 'Number quality: yellow',
  'chat.qualityRed': 'Number quality: red',
  'chat.accountError': 'The WhatsApp number is not connected.',
};

export const TABLES: Record<Lang, Table> = { pt: PT, en: EN };

export type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * A missing key renders as the key itself rather than as an empty string.
 *
 * Silence is the worst possible failure for copy: a blank denial reads as "you
 * may send" and a blank error reads as "nothing went wrong". `policy.FOO` on
 * screen is ugly and unmistakable, which is the right trade for a string that
 * was forgotten.
 */
export const translateWith = (lang: Lang): Translate =>
  (key, values) => {
    const template = TABLES[lang][key] ?? TABLES.pt[key] ?? key;

    if (values === undefined) return template;

    return Object.entries(values).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      template,
    );
  };

export const useCopy = (): { t: Translate; lang: Lang } => {
  const locale = useLocale();
  const lang = langOf(locale);

  return { t: useCallback(translateWith(lang), [lang]), lang };
};

/**
 * The sentence under a failed bubble.
 *
 * Falls back to the uncatalogued line rather than showing Meta's raw English —
 * which is written for a developer reading an API response, not for a rep
 * looking at a conversation.
 */
export const errorCopy = (
  t: Translate,
  errorCode: string | null,
  errorDetail: string | null,
): string => {
  if (errorCode === null) return errorDetail ?? t('error.unknown');

  const known = TABLES.pt[`error.${errorCode}`];

  return known === undefined ? t('error.unknown') : t(`error.${errorCode}`);
};
