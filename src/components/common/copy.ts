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
 * **The two languages are written side by side, not in two tables.** Parallel
 * tables let a key exist in one and not the other, and the failure is invisible
 * until a reader with the wrong locale meets an English string in a Portuguese
 * screen — or nothing at all. Paired entries make that unrepresentable, and a
 * translation that has not been done yet is visible on the line where it is
 * missing.
 *
 * Written pt-first and translated to en, not the reverse. The users are
 * Portuguese-speaking (A-6), and a Portuguese string that reads like a
 * translation of English is the tell that nobody who speaks it wrote it.
 */

export type Lang = 'pt' | 'en';

export const langOf = (locale: string | null | undefined): Lang =>
  typeof locale === 'string' && locale.toLowerCase().startsWith('pt') ? 'pt' : 'en';

type Entry = { pt: string; en: string };

const COPY = {
  // ─── Policy denials — the composer's disabled states (specs/08 §3.3) ──────
  'policy.ACCOUNT_NOT_CONNECTED': {
    pt: 'O número de WhatsApp não está ligado.',
    en: 'The WhatsApp number is not connected.',
  },
  'policy.THREAD_BLOCKED': {
    pt: 'Esta conversa está bloqueada.',
    en: 'This conversation is blocked.',
  },
  'policy.OPTED_OUT': {
    pt: 'Este contacto cancelou a subscrição.',
    en: 'This contact has unsubscribed.',
  },
  'policy.NO_CONSENT': {
    pt: 'Este contacto não deu consentimento para marketing.',
    en: 'This contact has not consented to marketing.',
  },
  'policy.WINDOW_CLOSED': {
    pt: 'A janela de 24 horas fechou. Só pode enviar um modelo aprovado.',
    en: 'The 24-hour window has closed. Only an approved template can be sent.',
  },
  'policy.TEMPLATE_UNAVAILABLE': {
    pt: 'Este modelo não está disponível para envio.',
    en: 'This template is not available to send.',
  },
  'policy.QUALITY_RED': {
    pt: 'A qualidade do número está em vermelho.',
    en: 'The number’s quality rating is red.',
  },

  'warning.WINDOW_EXPIRING_SOON': {
    pt: 'A janela fecha em breve.',
    en: 'The window closes soon.',
  },
  'warning.CONSENT_UNKNOWN_MARKETING': {
    pt: 'Sem consentimento registado para marketing.',
    en: 'No recorded marketing consent.',
  },
  'warning.QUALITY_YELLOW': {
    pt: 'A qualidade do número está em amarelo.',
    en: 'The number’s quality rating is yellow.',
  },

  // ─── Record states ────────────────────────────────────────────────────────
  'status.QUEUED': { pt: 'Em fila', en: 'Queued' },
  'status.ACCEPTED': { pt: 'Aceite', en: 'Accepted' },
  'status.SENT': { pt: 'Enviada', en: 'Sent' },
  'status.DELIVERED': { pt: 'Entregue', en: 'Delivered' },
  'status.READ': { pt: 'Lida', en: 'Read' },
  'status.PLAYED': { pt: 'Ouvida', en: 'Played' },
  'status.FAILED': { pt: 'Falhou', en: 'Failed' },

  'thread.OPEN': { pt: 'Aberta', en: 'Open' },
  'thread.AWAITING_REPLY': { pt: 'À espera de resposta', en: 'Awaiting reply' },
  'thread.CLOSED': { pt: 'Fechada', en: 'Closed' },
  'thread.NEEDS_REVIEW': { pt: 'Por identificar', en: 'Unidentified' },

  'consent.OPTED_IN': { pt: 'Subscrito', en: 'Subscribed' },
  'consent.OPTED_OUT': { pt: 'Cancelou', en: 'Unsubscribed' },
  'consent.UNKNOWN': { pt: 'Consentimento desconhecido', en: 'Consent unknown' },

  // ─── The Meta errors a rep can see on a bubble (appendix B) ───────────────
  'error.131047': {
    pt: 'Fora da janela de 24 horas — use um modelo.',
    en: 'Outside the 24-hour window — use a template.',
  },
  'error.131026': {
    pt: 'Este número não está no WhatsApp.',
    en: 'This number is not on WhatsApp.',
  },
  'error.131049': {
    pt: 'A Meta limitou as mensagens de marketing para este contacto hoje.',
    en: 'Meta capped marketing messages to this contact today.',
  },
  'error.131000': { pt: 'Erro temporário da Meta.', en: 'Temporary Meta error.' },
  'error.130429': {
    pt: 'Limite de envio atingido — tente novamente.',
    en: 'Send limit reached — try again.',
  },
  'error.132000': {
    pt: 'O modelo não corresponde às variáveis enviadas.',
    en: 'The template does not match the variables sent.',
  },
  'error.132001': {
    pt: 'O modelo não existe ou não está aprovado.',
    en: 'The template does not exist or is not approved.',
  },
  'error.132012': {
    pt: 'Um valor de variável foi recusado pela Meta.',
    en: 'Meta rejected a variable value.',
  },
  'error.133010': {
    pt: 'O número não está registado na Meta.',
    en: 'The number is not registered with Meta.',
  },
  'error.POLICY_WINDOW_CLOSED': {
    pt: 'A janela fechou antes do envio.',
    en: 'The window closed before the message was sent.',
  },
  'error.POLICY_OPTED_OUT': {
    pt: 'O contacto cancelou a subscrição antes do envio.',
    en: 'The contact unsubscribed before the message was sent.',
  },
  'error.POLICY_TEMPLATE_UNAVAILABLE': {
    pt: 'O modelo deixou de estar disponível.',
    en: 'The template became unavailable.',
  },
  'error.POLICY_ACCOUNT_ERROR': {
    pt: 'O número deixou de estar ligado.',
    en: 'The number is no longer connected.',
  },
  'error.UNKNOWN_ACCEPTANCE': {
    pt: 'Resultado desconhecido — verifique antes de reenviar.',
    en: 'Unknown outcome — check before resending.',
  },
  'error.MEDIA_TOO_LARGE': {
    pt: 'O ficheiro excede o limite da Meta.',
    en: 'The file exceeds Meta’s limit.',
  },
  'error.MEDIA_UNAVAILABLE': {
    pt: 'O ficheiro já não está disponível na Meta.',
    en: 'The file is no longer available from Meta.',
  },
  'error.CANCELLED': { pt: 'Cancelada.', en: 'Cancelled.' },
  'error.INTERNAL_TIMEOUT': { pt: 'Tempo esgotado.', en: 'Timed out.' },
  'error.CONFIG_MISSING': { pt: 'Configuração em falta.', en: 'Missing configuration.' },
  'error.unknown': { pt: 'Erro não catalogado.', en: 'Uncatalogued error.' },

  // ─── Campaign exclusions (specs/07) ───────────────────────────────────────
  'exclusion.OPTED_OUT': { pt: 'Cancelou a subscrição', en: 'Unsubscribed' },
  'exclusion.NO_CONSENT': { pt: 'Sem consentimento', en: 'No consent' },
  'exclusion.INVALID_PHONE': { pt: 'Número inválido', en: 'Invalid number' },
  'exclusion.DUPLICATE': { pt: 'Duplicado', en: 'Duplicate' },
  'exclusion.MISSING_VARIABLES': { pt: 'Variáveis em falta', en: 'Missing variables' },
  'exclusion.BLOCKED': { pt: 'Conversa bloqueada', en: 'Blocked conversation' },

  // ─── Shared verbs ─────────────────────────────────────────────────────────
  'common.cancel': { pt: 'Cancelar', en: 'Cancel' },
  'common.save': { pt: 'Guardar', en: 'Save' },
  'common.back': { pt: 'Voltar', en: 'Back' },
  'common.continue': { pt: 'Continuar', en: 'Continue' },
  'common.refresh': { pt: 'Actualizar', en: 'Refresh' },
  'common.retry': { pt: 'Tentar de novo', en: 'Try again' },
  'common.unavailable': {
    pt: 'Não foi possível ler os dados.',
    en: 'The data could not be read.',
  },
  'common.copy': { pt: 'Copiar', en: 'Copy' },
  'common.loading': { pt: 'A carregar…', en: 'Loading…' },
  'common.none': { pt: 'Nenhuma', en: 'None' },
  'common.yes': { pt: 'sim', en: 'yes' },
  'common.no': { pt: 'não', en: 'no' },
  'common.dismiss': { pt: 'Fechar aviso', en: 'Dismiss' },

  // ─── Chat ─────────────────────────────────────────────────────────────────
  'chat.windowOpen': { pt: 'Janela aberta', en: 'Window open' },
  'chat.windowClosed': { pt: 'Janela fechada', en: 'Window closed' },
  'chat.closesIn': { pt: 'fecha em {time}', en: 'closes in {time}' },
  'chat.loadOlder': { pt: 'Carregar mensagens anteriores', en: 'Load earlier messages' },
  'chat.empty': {
    pt: 'Ainda não há mensagens nesta conversa.',
    en: 'No messages in this conversation yet.',
  },
  'chat.noThread': {
    pt: 'Este contacto ainda não tem conversa de WhatsApp.',
    en: 'This contact has no WhatsApp conversation yet.',
  },
  'chat.start': { pt: 'Iniciar conversa', en: 'Start a conversation' },
  'chat.placeholder': { pt: 'Escreva uma mensagem', en: 'Write a message' },
  'chat.send': { pt: 'Enviar', en: 'Send' },
  'chat.chooseTemplate': { pt: 'Escolher modelo', en: 'Choose a template' },
  'chat.retry': { pt: 'Repetir', en: 'Retry' },
  'chat.details': { pt: 'Ver detalhes', en: 'Show details' },
  'chat.voiceNote': { pt: 'Mensagem de voz', en: 'Voice message' },
  'chat.download': { pt: 'Transferir ({size})', en: 'Download ({size})' },
  'chat.unsupported': { pt: 'Mensagem não suportada', en: 'Unsupported message' },
  'chat.today': { pt: 'Hoje', en: 'Today' },
  'chat.yesterday': { pt: 'Ontem', en: 'Yesterday' },
  'chat.reconnect': { pt: 'Retomar actualizações', en: 'Resume updates' },
  'chat.suspended': { pt: 'Actualizações em pausa.', en: 'Updates paused.' },
  'chat.offline': { pt: 'Sem ligação ao servidor.', en: 'No connection to the server.' },
  'chat.sending': { pt: 'A enviar…', en: 'Sending…' },
  'chat.campaign': { pt: 'Campanha', en: 'Campaign' },
  'chat.template': { pt: 'Modelo', en: 'Template' },
  'chat.needsReview': { pt: 'Por identificar', en: 'Unidentified' },
  'chat.blocked': { pt: 'Bloqueada', en: 'Blocked' },
  'chat.testAccount': { pt: 'Número de teste', en: 'Test number' },
  'chat.qualityYellow': { pt: 'Qualidade do número: amarelo', en: 'Number quality: yellow' },
  'chat.qualityRed': { pt: 'Qualidade do número: vermelho', en: 'Number quality: red' },
  'chat.accountError': {
    pt: 'O número de WhatsApp não está ligado.',
    en: 'The WhatsApp number is not connected.',
  },
  'chat.block': { pt: 'Bloquear', en: 'Block' },
  'chat.unblock': { pt: 'Desbloquear', en: 'Unblock' },
  'chat.close': { pt: 'Fechar', en: 'Close' },
  'chat.reopen': { pt: 'Reabrir', en: 'Reopen' },
  'chat.noTemplates': {
    pt: 'Não há modelos publicados para este número.',
    en: 'No published templates for this number.',
  },
  'chat.missing': { pt: 'Em falta', en: 'Missing' },
  'chat.noPermission': { pt: 'Sem permissão para enviar.', en: 'You may not send messages.' },

  // ─── Inbox ────────────────────────────────────────────────────────────────
  'inbox.mine': { pt: 'Minhas', en: 'Mine' },
  'inbox.unassigned': { pt: 'Sem responsável', en: 'Unassigned' },
  'inbox.all': { pt: 'Todas', en: 'All' },
  'inbox.campaign_replies': { pt: 'Respostas a campanhas', en: 'Campaign replies' },
  'inbox.window_expiring': { pt: 'A fechar', en: 'Closing soon' },
  'inbox.closed': { pt: 'Fechadas', en: 'Closed' },
  'inbox.pick': { pt: 'Escolha uma conversa', en: 'Pick a conversation' },
  'inbox.conversations': { pt: 'Conversas', en: 'Conversations' },
  'inbox.empty': { pt: 'Nenhuma conversa neste filtro.', en: 'No conversations in this filter.' },

  // ─── Live toasts (D-10 layer 2) ───────────────────────────────────────────
  'toast.newMessage': { pt: 'Nova mensagem de {name}', en: 'New message from {name}' },
  'toast.newMessages': {
    pt: '{count} conversas com mensagens novas',
    en: '{count} conversations with new messages',
  },

  // ─── Campaigns ────────────────────────────────────────────────────────────
  'campaign.title': { pt: 'Campanhas', en: 'Campaigns' },
  'campaign.new': { pt: 'Nova campanha', en: 'New campaign' },
  'campaign.none': { pt: 'Ainda não há campanhas.', en: 'No campaigns yet.' },
  'campaign.running': {
    pt: 'Uma campanha está a decorrer — os números actualizam sozinhos.',
    en: 'A campaign is running — the figures update by themselves.',
  },
  'campaign.col.name': { pt: 'Nome', en: 'Name' },
  'campaign.col.status': { pt: 'Estado', en: 'Status' },
  'campaign.col.created': { pt: 'Criada', en: 'Created' },
  'campaign.col.phone': { pt: 'Telefone', en: 'Phone' },
  'campaign.col.reason': { pt: 'Motivo', en: 'Reason' },

  'campaign.step.basics': { pt: 'Básico', en: 'Basics' },
  'campaign.step.template': { pt: 'Modelo', en: 'Template' },
  'campaign.step.audience': { pt: 'Audiência', en: 'Audience' },
  'campaign.step.variables': { pt: 'Variáveis', en: 'Variables' },

  'campaign.name': { pt: 'Nome', en: 'Name' },
  'campaign.account': { pt: 'Número de envio', en: 'Sending number' },
  'campaign.schedule': { pt: 'Agendamento', en: 'Schedule' },
  'campaign.scheduleHint': {
    pt: 'Vazio envia assim que for lançada. A hora é a do seu navegador e é guardada em UTC.',
    en: 'Empty sends as soon as it is launched. The time is your browser’s and is stored in UTC.',
  },
  'campaign.templateHint': {
    pt: 'Só modelos aprovados e publicados. Os de autenticação não servem para campanhas.',
    en: 'Approved and published templates only. Authentication templates have no bulk use.',
  },
  'campaign.source': { pt: 'Origem', en: 'Source' },
  'campaign.sourceView': { pt: 'Vista guardada de Pessoas', en: 'Saved People view' },
  'campaign.sourceManual': { pt: 'Lista de ids', en: 'List of ids' },
  'campaign.view': { pt: 'Vista', en: 'View' },
  'campaign.personIds': { pt: 'Ids de Pessoa', en: 'Person ids' },
  'campaign.personIdsHint': {
    pt: 'Separados por vírgula ou por linha.',
    en: 'Separated by commas or newlines.',
  },
  'campaign.noVariables': {
    pt: 'Este modelo não tem variáveis.',
    en: 'This template has no variables.',
  },
  'campaign.bindingField': { pt: 'Campo do contacto', en: 'Contact field' },
  'campaign.bindingStatic': { pt: 'Texto fixo', en: 'Fixed text' },
  'campaign.field': { pt: 'Campo', en: 'Field' },
  'campaign.text': { pt: 'Texto', en: 'Text' },
  'campaign.fallback': { pt: 'Alternativa', en: 'Fallback' },
  'campaign.fallbackHint': {
    pt: 'Usada quando o campo está vazio. Sem alternativa, o contacto é excluído.',
    en: 'Used when the field is empty. Without one, the contact is excluded.',
  },
  'campaign.build': { pt: 'Construir audiência', en: 'Build audience' },
  'campaign.createdNoId': {
    pt: 'O servidor criou a campanha mas não devolveu o id.',
    en: 'The server created the campaign but returned no id.',
  },

  'campaign.numbers': { pt: 'Números', en: 'Figures' },
  'campaign.counter.recipientCount': { pt: 'Destinatários', en: 'Recipients' },
  'campaign.counter.queuedCount': { pt: 'Em fila', en: 'Queued' },
  'campaign.counter.sentCount': { pt: 'Enviadas', en: 'Sent' },
  'campaign.counter.deliveredCount': { pt: 'Entregues', en: 'Delivered' },
  'campaign.counter.readCount': { pt: 'Lidas', en: 'Read' },
  'campaign.counter.respondedCount': { pt: 'Respostas', en: 'Replies' },
  'campaign.counter.failedCount': { pt: 'Falhadas', en: 'Failed' },
  'campaign.counter.skippedCount': { pt: 'Ignoradas', en: 'Skipped' },
  'campaign.counter.excludedCount': { pt: 'Excluídas', en: 'Excluded' },
  'campaign.counter.actualCost': { pt: 'Custo real', en: 'Actual cost' },

  'campaign.launch': { pt: 'Lançar', en: 'Launch' },
  'campaign.pause': { pt: 'Pausar', en: 'Pause' },
  'campaign.resume': { pt: 'Retomar', en: 'Resume' },
  'campaign.cancel': { pt: 'Cancelar', en: 'Cancel' },
  'campaign.launchNeedsPreflight': {
    pt: 'A verificar destinatários e custo. O botão de lançamento aparece quando os números estiverem prontos.',
    en: 'Checking recipients and cost. The launch button appears once the numbers are ready.',
  },
  'campaign.launchSubtitle': {
    pt: '{count} destinatários, ~${cost}',
    en: '{count} recipients, ~${cost}',
  },
  'campaign.cancelSubtitle': {
    pt: 'As mensagens ainda não enviadas não serão enviadas.',
    en: 'Messages not yet sent will not be sent.',
  },
  'campaign.reason': { pt: 'Motivo', en: 'Reason' },
  'campaign.pacing': {
    pt: 'O ritmo foi reduzido para respeitar o limite do número — a campanha demora mais do que o previsto, e nada foi perdido.',
    en: 'The pace was reduced to respect the number’s limit — the campaign takes longer than planned, and nothing was lost.',
  },

  'campaign.preflightAudience': { pt: 'Pré-voo — audiência', en: 'Pre-flight — audience' },
  'campaign.preflightCost': { pt: 'Pré-voo — custo e limite', en: 'Pre-flight — cost and limit' },
  'campaign.preflightQuality': {
    pt: 'Pré-voo — qualidade e modelo',
    en: 'Pre-flight — quality and template',
  },
  'campaign.preflightPreview': { pt: 'Pré-voo — como fica', en: 'Pre-flight — how it reads' },
  'campaign.willReceive': { pt: 'Vão receber', en: 'Will receive' },
  'campaign.excluded': { pt: 'Excluídos', en: 'Excluded' },
  'campaign.perMessage': {
    pt: '~${total} a ${rate} por mensagem',
    en: '~${total} at ${rate} per message',
  },
  'campaign.tierLine': {
    pt: 'Escalão {tier}: {used} usados de {limit}, {reserve} reservados para conversas 1:1 — {available} disponíveis hoje.',
    en: 'Tier {tier}: {used} used of {limit}, {reserve} reserved for 1:1 conversations — {available} available today.',
  },
  'campaign.spreadFits': { pt: 'Cabe tudo no dia de hoje.', en: 'It all fits in today.' },
  'campaign.spreadDays': {
    pt: '{firstDay} hoje, e o resto ao longo de {days} dias — o escalão diário não chega para a audiência toda.',
    en: '{firstDay} today, and the rest over {days} days — the daily tier does not cover the whole audience.',
  },
  'campaign.quality': { pt: 'Qualidade', en: 'Quality' },
  'campaign.acknowledge': {
    pt: 'Reconheço a classificação e quero lançar mesmo assim',
    en: 'I acknowledge the rating and want to launch anyway',
  },
  'campaign.launchAnyway': { pt: 'Lançar mesmo assim', en: 'Launch anyway' },
  'campaign.testSend': { pt: 'Envio de teste', en: 'Test send' },
  'campaign.recipientsSample': {
    pt: 'Destinatários (amostra de {count})',
    en: 'Recipients (sample of {count})',
  },

  // ─── Settings ─────────────────────────────────────────────────────────────
  'settings.tab.connection': { pt: 'Ligação', en: 'Connection' },
  'settings.tab.health': { pt: 'Saúde', en: 'Health' },
  'settings.tab.templates': { pt: 'Modelos', en: 'Templates' },
  'settings.tab.variables': { pt: 'Variáveis', en: 'Variables' },
  'settings.tab.diagnostics': { pt: 'Diagnóstico', en: 'Diagnostics' },
  'settings.variablesNote': {
    pt: 'Definições da aplicação. As palavras-chave e o texto das confirmações estão aqui de propósito: mudá-los é uma edição, nunca um deploy.',
    en: 'Application settings. The keywords and the confirmation wording live here on purpose: changing them is an edit, never a deploy.',
  },
  'settings.variableSaved': { pt: '{key} guardada', en: '{key} saved' },

  'settings.summary': {
    pt: '{displayName} · qualidade {quality} · escalão {tier}',
    en: '{displayName} · quality {quality} · tier {tier}',
  },
  'settings.test': { pt: 'Testar ligação', en: 'Test connection' },
  'settings.tested': { pt: 'Ligação testada.', en: 'Connection tested.' },
  'settings.syncTemplates': { pt: 'Sincronizar modelos', en: 'Sync templates' },
  'settings.syncRequested': { pt: 'Sincronização pedida.', en: 'Sync requested.' },
  'settings.disconnect': { pt: 'Desligar', en: 'Disconnect' },
  'settings.dangerZone': { pt: 'Zona de perigo', en: 'Danger zone' },
  'settings.disconnectWarning': {
    pt: 'Desligar este número pára o envio e a recepção de mensagens WhatsApp neste espaço de trabalho até que volte a ser ligado.',
    en: 'Disconnecting this number stops sending and receiving WhatsApp messages in this workspace until it is connected again.',
  },
  'settings.disconnectConfirm': {
    pt: 'Confirmar e desligar',
    en: 'Confirm disconnect',
  },
  'settings.connectTitle': { pt: 'Ligar um número', en: 'Connect a number' },
  'settings.connect': { pt: 'Ligar', en: 'Connect' },
  'settings.name': { pt: 'Nome', en: 'Name' },
  'settings.phoneNumberIdHint': {
    pt: 'Meta → WhatsApp → API Setup.',
    en: 'Meta → WhatsApp → API Setup.',
  },
  'settings.callingCode': { pt: 'Indicativo por omissão', en: 'Default calling code' },
  'settings.isTestAccount': { pt: 'É um número de teste', en: 'This is a test number' },

  'settings.callback': { pt: 'Callback da Meta', en: 'Meta callback' },
  'settings.callbackUrl': { pt: 'URL do callback', en: 'Callback URL' },
  'settings.directUrl': { pt: 'Forma directa', en: 'Direct form' },
  'settings.verifyUrl': { pt: 'URL de verificação', en: 'Verification URL' },
  'settings.verifyToken': { pt: 'Token de verificação', en: 'Verify token' },
  'settings.verifyTokenSet': {
    pt: 'configurado na variável de servidor META_VERIFY_TOKEN',
    en: 'configured in the META_VERIFY_TOKEN server variable',
  },
  'settings.verifyTokenMissing': {
    pt: '⚠ em falta — defina META_VERIFY_TOKEN',
    en: '⚠ missing — set META_VERIFY_TOKEN',
  },
  'settings.requiredFields': { pt: 'Campos a subscrever', en: 'Fields to subscribe' },
  'settings.copyFields': { pt: 'Copiar lista de campos', en: 'Copy the field list' },

  'settings.health.token': { pt: 'Token de acesso', en: 'Access token' },
  'settings.health.token.remedy': {
    pt: 'A verificação horária não corre há mais de duas horas, ou falhou. Veja specs/11 §2.',
    en: 'The hourly check has not run for over two hours, or it failed. See specs/11 §2.',
  },
  'settings.health.webhook': { pt: 'Webhook', en: 'Webhook' },
  'settings.health.webhook.remedy': {
    pt: 'Não chegam eventos há mais tempo do que o limite. Confirme a subscrição na Meta.',
    en: 'No events for longer than the threshold. Check the subscription at Meta.',
  },
  'settings.health.quality': { pt: 'Qualidade do número', en: 'Number quality' },
  'settings.health.quality.remedy': {
    pt: 'A Meta baixou a classificação. Reduza envios de marketing e reveja os modelos.',
    en: 'Meta lowered the rating. Cut marketing sends and review the templates.',
  },
  'settings.health.tier': { pt: 'Escalão diário', en: 'Daily tier' },
  'settings.health.tier.remedy': {
    pt: 'A reserva para conversas 1:1 já consumiu o que resta — nenhuma campanha arranca hoje.',
    en: 'The 1:1 reserve has taken what is left — no campaign starts today.',
  },
  'settings.health.failedWebhookEvents': {
    pt: 'Entregas falhadas (24h)',
    en: 'Failed deliveries (24h)',
  },
  'settings.health.failedWebhookEvents.remedy': {
    pt: 'Há eventos por processar. Veja o separador Diagnóstico.',
    en: 'There are unprocessed events. See the Diagnostics tab.',
  },
  'settings.templateQuality': { pt: 'Qualidade {score}', en: 'Quality {score}' },
  'settings.health.detail.tokenNever': {
    pt: 'Nunca verificado',
    en: 'Never checked',
  },
  'settings.health.detail.tokenChecked': {
    pt: 'Verificado {when}',
    en: 'Checked {when}',
  },
  'settings.health.detail.webhookNone': {
    pt: 'Ainda sem eventos recebidos',
    en: 'No events received yet',
  },
  'settings.health.detail.webhookLast': {
    pt: 'Último evento {when}',
    en: 'Last event {when}',
  },
  'settings.health.detail.quality': {
    pt: 'Classificação {rating}',
    en: 'Rated {rating}',
  },
  'settings.health.detail.tier': {
    pt: '{available} envios disponíveis hoje de {limit}, com {reserve} reservados para conversas 1:1',
    en: '{available} sends available today of {limit}, with {reserve} held back for 1:1 conversations',
  },
  'settings.health.detail.none': { pt: 'Nenhuma', en: 'None' },
  'settings.health.detail.count': { pt: '{count}', en: '{count}' },
  'settings.health.detail.stuck': {
    pt: '{count} há mais de {minutes} minutos',
    en: '{count} for more than {minutes} minutes',
  },
  'settings.health.stuckOutbound': { pt: 'Mensagens presas', en: 'Stuck messages' },
  'settings.health.stuckOutbound.remedy': {
    pt: 'Mensagens em fila há mais de 15 minutos. A verificação horária volta a tentar.',
    en: 'Messages queued for over 15 minutes. The hourly check retries them.',
  },
  'settings.ok': { pt: 'OK', en: 'OK' },
  'settings.needsAttention': { pt: 'a precisar de atenção', en: 'needs attention' },

  'settings.noTemplates': {
    pt: 'Nenhum modelo sincronizado.',
    en: 'No templates synced.',
  },
  'settings.publish': { pt: 'Publicar', en: 'Publish' },
  'settings.unpublish': { pt: 'Despublicar', en: 'Unpublish' },

  'settings.failedEvents': { pt: 'Entregas falhadas (24h)', en: 'Failed deliveries (24h)' },
  'settings.stuckMessages': { pt: 'Mensagens presas', en: 'Stuck messages' },
  'settings.attempts': { pt: 'tentativas', en: 'attempts' },
  'settings.consent': { pt: 'Consentimento', en: 'Consent' },
  'settings.consentNote': {
    pt: 'As palavras-chave de subscrição e cancelamento, e o texto da confirmação, são variáveis da aplicação — edite-as no separador Variáveis, aqui ao lado. Não são código de propósito: o texto é revisto por aconselhamento jurídico e uma alteração não deve exigir um deploy.',
    en: 'The opt-in and opt-out keywords, and the confirmation wording, are application variables — edit them in the Variables tab, next to this one. They are deliberately not code: the wording is reviewed by counsel, and a change must never require a deploy.',
  },
} satisfies Record<string, Entry>;

export type CopyKey = keyof typeof COPY;

type Table = Record<string, string>;

const tableFor = (lang: Lang): Table =>
  Object.fromEntries(Object.entries(COPY).map(([key, entry]) => [key, entry[lang]]));

export const TABLES: Record<Lang, Table> = { pt: tableFor('pt'), en: tableFor('en') };

export type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * A missing key renders as the key itself rather than as an empty string.
 *
 * Silence is the worst possible failure for copy: a blank denial reads as "you
 * may send" and a blank error reads as "nothing went wrong". `policy.FOO` on
 * screen is ugly and unmistakable, which is the right trade for a string that
 * was forgotten. There is no cross-language fallback, because paired entries
 * make a half-translated key impossible — an unknown key is unknown in both.
 */
export const translateWith =
  (lang: Lang): Translate =>
  (key, values) => {
    const template = TABLES[lang][key] ?? key;

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

  return Object.prototype.hasOwnProperty.call(COPY, `error.${errorCode}`)
    ? t(`error.${errorCode}`)
    : t('error.unknown');
};
