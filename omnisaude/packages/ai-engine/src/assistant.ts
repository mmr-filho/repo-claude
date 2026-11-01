import { z } from 'zod';

/**
 * Assistente do cidadão no WhatsApp (CID-2).
 *
 * Tudo o que não depende de banco fica aqui: intenções, leitura por regras (funciona sem chave de IA),
 * sinais de alerta que sempre prevalecem sobre o modelo, orientação de triagem, textos fixos e o prompt
 * com o formato estruturado da resposta do modelo.
 */

export const INTENCOES = [
  'SAUDACAO',
  'MENU',
  'AGENDA',
  'AGENDAR',
  'CONFIRMAR',
  'CANCELAR',
  'REMARCAR',
  'EXAMES',
  'VACINAS',
  'REMEDIOS',
  'FILA',
  'SENHA',
  'UNIDADES',
  'TRIAGEM',
  'DUVIDA',
  'ATENDENTE',
  'OUVIDORIA',
  'DESPEDIDA',
  'OUTRO',
] as const;
export type Intencao = (typeof INTENCOES)[number];

export const GRAVIDADES = ['EMERGENCIA', 'URGENCIA', 'POUCO_URGENTE', 'NAO_URGENTE'] as const;
export type Gravidade = (typeof GRAVIDADES)[number];

/** Intenções que precisam de cadastro identificado (dados pessoais). */
export const INTENCOES_PESSOAIS: readonly Intencao[] = ['AGENDA', 'AGENDAR', 'CONFIRMAR', 'CANCELAR', 'REMARCAR', 'EXAMES', 'VACINAS', 'REMEDIOS', 'FILA', 'SENHA'];

/** Saída estruturada do modelo. */
export const assistantOutputSchema = z.object({
  intencao: z.enum(INTENCOES).describe('O que o cidadão quer nesta mensagem'),
  resposta: z
    .string()
    .max(1200)
    .describe(
      'Texto curto, em português simples e acolhedor, pronto para o WhatsApp. Vazio quando a intenção é transacional (agenda, exames, vacinas, remédios, fila, senha), porque o sistema monta a resposta com os dados reais.',
    ),
  gravidade: z.enum(GRAVIDADES).nullable().describe('Só para TRIAGEM: gravidade aparente dos sintomas relatados'),
  sinais: z.array(z.string().max(80)).max(10).describe('Sintomas ou sinais relevantes citados pelo cidadão'),
  especialidade: z.string().max(60).nullable().describe('Especialidade ou serviço pedido, quando houver'),
  precisaHumano: z.boolean().describe('Verdadeiro quando o pedido exige uma pessoa da unidade (reclamação, caso delicado, pedido fora do que o assistente faz)'),
});
export type AssistantOutput = z.infer<typeof assistantOutputSchema>;

export interface AssistantUnidade {
  nome: string;
  tipo: string;
  endereco?: string | null;
  telefone?: string | null;
  horario?: string | null;
}

export interface AssistantPromptInput {
  instituicao: string;
  nomeAssistente: string;
  unidades: AssistantUnidade[];
  faq: { pergunta: string; resposta: string }[];
  /** Pessoa identificada pelo telefone (null quando desconhecida): só o necessário para orientar. */
  cidadao: { primeiroNome: string; resumo: string[] } | null;
  agora: string;
}

export function normalizarTexto(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Sinais que, presentes, levam sempre à orientação de emergência (192/UPA), independentemente do modelo. */
export const SINAIS_DE_ALERTA: { padrao: RegExp; descricao: string }[] = [
  { padrao: /dor (no|do) peito|peito apertad|aperto no peito|dor toracic/, descricao: 'dor no peito' },
  { padrao: /falta de ar|nao consigo respirar|nao consegue respirar|sufoc|respirar direito|respiracao dificil/, descricao: 'falta de ar' },
  { padrao: /desmai|apagou|apaguei|perdeu os sentidos|inconsciente|nao acorda|nao responde/, descricao: 'desmaio ou inconsciência' },
  { padrao: /convuls|ataque epile/, descricao: 'convulsão' },
  { padrao: /sangr\w* (muito|sem parar|que nao para)|muito sangue|hemorragia|vomitando sangue|vomito com sangue/, descricao: 'sangramento intenso' },
  { padrao: /boca torta|fala enrolad|fraqueza de um lado|dormencia de um lado|formigamento de um lado|\bavc\b|derrame/, descricao: 'sinais de AVC' },
  { padrao: /pior dor de cabeca da (minha )?vida|dor de cabeca (muito )?forte (de repente|subita)/, descricao: 'dor de cabeça súbita e intensa' },
  { padrao: /engasg/, descricao: 'engasgo' },
  { padrao: /envenen|intoxic|overdose|tomou (muitos|varios) (remedio|comprimido)|ingeriu/, descricao: 'intoxicação' },
  { padrao: /suicid|me matar|tirar (a )?minha vida|quero morrer|nao quero mais viver/, descricao: 'risco à própria vida' },
  { padrao: /bolsa (estourou|rompeu)|bebe (esta )?nascendo|em trabalho de parto|contracoes? (fortes|de 5)/, descricao: 'trabalho de parto' },
  { padrao: /queimadura (grande|grave|extensa)|queimou (o corpo|todo)/, descricao: 'queimadura extensa' },
  { padrao: /atropel|acidente (grave|de carro|de moto)|capot|caiu de (altura|cima)|bateu a cabeca e/, descricao: 'trauma grave' },
  { padrao: /bebe .*(febre|molinho|nao mama)|recem[- ]nascido .*febre/, descricao: 'bebê pequeno com febre ou prostrado' },
  { padrao: /choque anafil|alergia .*(garganta|inchou|inchand)|labio inchad|lingua inchad|garganta fechando/, descricao: 'reação alérgica grave' },
];

export function sinaisDeAlerta(texto: string): string[] {
  const t = normalizarTexto(texto);
  return SINAIS_DE_ALERTA.filter((r) => r.padrao.test(t)).map((r) => r.descricao);
}

const URGENCIA =
  /febre (alta|de 39|de 40|acima de 39)|39,|40 graus|vomit\w* (sem parar|que nao para|muito)|nao para de vomitar|diarreia (forte|com sangue)|dor (muito )?forte|dor insuportavel|cortou|corte (fundo|grande)|precisa de pontos|quebr(ou|ei)|fratur|torceu|crise de asma|chiado|dor de barriga forte|urinando sangue|nao consegue urinar|pressao (muito )?alta|pressao 1[8-9]|pressao 2\d|glicemia (alta|acima)|acucar (muito )?alt|desidrat|mordid|picad|ferid/;
const SINTOMAS =
  /\bdor\b|dores|febre|tosse|vomit|enjoo|nausea|diarreia|sintoma|passando mal|mal estar|machuc|sangr|tontur|gripe|resfriad|garganta|ouvido|coceira|alergia|mancha|inchad|inchaco|cansaco|fraqueza|ardencia|queimacao|corrimento|pressao|glicemia|dengue|covid|dor de cabeca|cabeca doendo|barriga/;

/** O texto descreve sintomas que pedem avaliação ainda hoje (sem sinal de emergência)? */
export function urgenciaNoTexto(texto: string): boolean {
  const t = normalizarTexto(texto);
  return SINTOMAS.test(t) && URGENCIA.test(t);
}

/** Leitura por regras: menu numérico e palavras-chave. Serve sem IA e como rede de segurança com IA. */
export function interpretarPorRegras(texto: string): { intencao: Intencao; gravidade: Gravidade | null; sinais: string[] } {
  const t = normalizarTexto(texto);
  const alerta = sinaisDeAlerta(texto);
  if (alerta.length) return { intencao: 'TRIAGEM', gravidade: 'EMERGENCIA', sinais: alerta };
  const menu: Record<string, Intencao> = { '1': 'AGENDA', '2': 'AGENDAR', '3': 'EXAMES', '4': 'VACINAS', '5': 'REMEDIOS', '6': 'FILA', '7': 'UNIDADES', '8': 'TRIAGEM', '9': 'ATENDENTE', '0': 'MENU' };
  if (menu[t]) return { intencao: menu[t]!, gravidade: null, sinais: [] };
  const regras: [RegExp, Intencao][] = [
    [/^(oi|ola|bom dia|boa tarde|boa noite|opa|eai|e ai|hey|hello)\b/, 'SAUDACAO'],
    [/\b(menu|opcoes|opcao|ajuda|inicio|comecar|voltar)\b/, 'MENU'],
    [/\b(ouvidoria|reclama|denunci|elogi|sugest|sugiro|manifestac)/, 'OUVIDORIA'],
    [/\b(atendente|humano|pessoa de verdade|falar com alguem|falar com uma pessoa)/, 'ATENDENTE'],
    [/\b(remarcar|mudar (o |a )?(horario|data|dia)|trocar (o |a )?(horario|data|dia)|adiar)/, 'REMARCAR'],
    [/\b(cancelar|desmarcar|nao vou poder ir|nao posso ir)/, 'CANCELAR'],
    [/\b(confirmar|confirmo|confirmado|vou sim|estarei la)/, 'CONFIRMAR'],
    [/\b(marcar|agendar|quero (uma )?consulta|preciso de (uma )?consulta|consulta nova|nova consulta|vaga para consulta|horario para consulta)/, 'AGENDAR'],
    [/\b(minha agenda|meus agendamentos|minhas consultas|minha consulta|quando e (a )?minha consulta|tenho consulta|consulta marcada|agendamento)/, 'AGENDA'],
    [/\b(exame|resultado|laboratorio)/, 'EXAMES'],
    [/\b(vacina|carteira de vacinacao|cartao de vacina|imuniza)/, 'VACINAS'],
    [/\b(remedio|medicamento|receita|farmacia|retirar (o |os )?(remedio|medicamento))/, 'REMEDIOS'],
    [/\b(fila|regulacao|encaminhamento|especialista|tfd|tratamento fora|viagem|transporte|posicao)/, 'FILA'],
    [/\b(senha|minha vez|fui chamad)/, 'SENHA'],
    [/\b(unidade|ubs|posto|upa|hospital|policlinica|caps|endereco|telefone|horario de (funcionamento|atendimento)|que horas (abre|fecha)|aberto|funciona|onde fica|como chego)/, 'UNIDADES'],
    [/\b(obrigad|valeu|tchau|ate mais|ate logo|falou)/, 'DESPEDIDA'],
    [/\b(consulta)\b/, 'AGENDA'],
  ];
  for (const [re, intencao] of regras) if (re.test(t)) return { intencao, gravidade: null, sinais: [] };
  if (SINTOMAS.test(t)) return { intencao: 'TRIAGEM', gravidade: URGENCIA.test(t) ? 'URGENCIA' : 'POUCO_URGENTE', sinais: [] };
  return { intencao: 'OUTRO', gravidade: null, sinais: [] };
}

/** Gravidade final: os sinais de alerta por regra sempre prevalecem; depois vale a leitura do modelo. */
export function gravidadeFinal(texto: string, doModelo: Gravidade | null | undefined): { gravidade: Gravidade; sinais: string[] } {
  const alerta = sinaisDeAlerta(texto);
  if (alerta.length) return { gravidade: 'EMERGENCIA', sinais: alerta };
  if (doModelo) return { gravidade: doModelo, sinais: [] };
  const t = normalizarTexto(texto);
  return { gravidade: URGENCIA.test(t) ? 'URGENCIA' : 'POUCO_URGENTE', sinais: [] };
}

export function orientacaoTriagem(gravidade: Gravidade, opts: { sinais?: string[]; upa?: AssistantUnidade | null; ubs?: AssistantUnidade | null }): string {
  const local = (u?: AssistantUnidade | null) => (u ? `${u.nome}${u.endereco ? ` (${u.endereco})` : ''}` : null);
  switch (gravidade) {
    case 'EMERGENCIA': {
      const upa = local(opts.upa);
      return [
        `⚠️ Pelo que você descreveu${opts.sinais?.length ? ` (${opts.sinais.join(', ')})` : ''}, isso pode ser uma emergência.`,
        'Ligue agora para o SAMU: 192. Se tiver alguém com você, peça para ligar enquanto fica ao seu lado.',
        upa ? `Se for mais rápido ir, a unidade de urgência mais próxima é ${upa}. Não vá dirigindo sozinho(a).` : 'Se for mais rápido ir, procure a UPA ou o pronto-socorro mais próximo. Não vá dirigindo sozinho(a).',
        'Não espere passar e não tome remédio por conta própria.',
      ].join('\n');
    }
    case 'URGENCIA': {
      const upa = local(opts.upa);
      return [
        'Isso merece avaliação ainda hoje, sem agendar.',
        upa ? `Procure a ${upa}, que atende 24 horas.` : 'Procure a UPA ou o pronto atendimento mais próximo.',
        'Leve um documento com foto e o cartão do SUS. Se piorar (falta de ar, desmaio, dor no peito, confusão), ligue 192.',
      ].join('\n');
    }
    case 'POUCO_URGENTE': {
      const ubs = local(opts.ubs);
      return [
        'Pelo que você contou, dá para ser avaliado(a) na sua unidade de saúde, de preferência hoje ou amanhã.',
        ubs ? `A sua unidade é ${ubs}: vá no horário de atendimento e peça acolhimento na recepção.` : 'Vá à sua UBS no horário de atendimento e peça acolhimento na recepção.',
        'Posso ver um horário de consulta para você: responda MARCAR. Se aparecer falta de ar, dor no peito, desmaio ou sangramento forte, ligue 192.',
      ].join('\n');
    }
    default:
      return 'Pelo que você contou, não parece urgente. Observe os sintomas, beba água e descanse. Se continuar por mais de 2 ou 3 dias, piorar ou aparecer febre alta, procure sua unidade de saúde. Quer marcar uma consulta? Responda MARCAR.';
  }
}

export function textoMenu(nomeAssistente: string, primeiroNome?: string | null): string {
  return [
    `Olá${primeiroNome ? `, ${primeiroNome}` : ''}! Sou ${nomeAssistente}, o assistente virtual da saúde do seu município. Posso ajudar com:`,
    '1️⃣ Minhas consultas',
    '2️⃣ Marcar consulta',
    '3️⃣ Meus exames',
    '4️⃣ Vacinas',
    '5️⃣ Remédios',
    '6️⃣ Fila da regulação e TFD',
    '7️⃣ Unidades e horários',
    '8️⃣ Estou com sintomas',
    '9️⃣ Falar com um atendente',
    'Responda com o número ou escreva com suas palavras. Em emergência, ligue 192.',
  ].join('\n');
}

export const TEXTO_NAO_IDENTIFICADO =
  'Não encontrei um cadastro com WhatsApp autorizado neste número. Para ver sua agenda, exames e vacinas por aqui, procure a recepção da sua unidade de saúde, confira o telefone e autorize o contato por WhatsApp. Enquanto isso, posso informar unidades e horários (responda 7) ou orientar sobre sintomas (responda 8).';

export const TEXTO_ATENDENTE = (unidade?: string | null) =>
  `Certo. Avisei a equipe${unidade ? ` da ${unidade}` : ''} e uma pessoa vai responder por aqui no horário de atendimento. Se for urgente, ligue 192 ou procure a UPA.`;

export const TEXTO_DESPEDIDA = 'Por nada! Se precisar, é só mandar mensagem. Cuide-se.';

/** Prompt de sistema: estável por instituição (cabe em cache do provedor). */
export function buildAssistantSystemPrompt(input: AssistantPromptInput): string {
  const unidades = input.unidades.length
    ? input.unidades.map((u) => `- ${u.nome} (${u.tipo})${u.endereco ? `, ${u.endereco}` : ''}${u.horario ? `, horário: ${u.horario}` : ''}${u.telefone ? `, tel. ${u.telefone}` : ''}`).join('\n')
    : '- (nenhuma unidade cadastrada)';
  const faq = input.faq.length ? input.faq.map((f) => `P: ${f.pergunta}\nR: ${f.resposta}`).join('\n') : '(sem perguntas frequentes cadastradas)';
  return [
    `Você é ${input.nomeAssistente}, assistente virtual da ${input.instituicao} (saúde pública, SUS) no WhatsApp. Data e hora atuais: ${input.agora}.`,
    '',
    'Seu papel: acolher o cidadão, entender o que ele quer e classificar em uma intenção. Responda em português do Brasil, simples, curto (no máximo 6 linhas), sem jargão, tratando a pessoa com respeito. Nunca invente dados pessoais, horários, resultados ou disponibilidade: isso o sistema consulta e envia. Quando a intenção for transacional (AGENDA, AGENDAR, CONFIRMAR, CANCELAR, REMARCAR, EXAMES, VACINAS, REMEDIOS, FILA, SENHA), deixe "resposta" vazia.',
    '',
    'Regras de segurança:',
    '- Você não faz diagnóstico nem prescreve. Em TRIAGEM, classifique a gravidade (EMERGENCIA: risco de vida, oriente 192/UPA; URGENCIA: avaliação hoje na UPA; POUCO_URGENTE: UBS hoje ou amanhã; NAO_URGENTE: observar e agendar) e escreva uma orientação curta, sem minimizar sinais de alerta.',
    '- Não exponha valores de exames, diagnósticos ou medicamentos de terceiros. Se o pedido parecer de outra pessoa, oriente a pessoa a usar o próprio número ou procurar a unidade.',
    '- Reclamações, denúncias, elogios e sugestões sobre o serviço: intenção OUVIDORIA (o sistema registra na ouvidoria com protocolo e prazo legal). Pedidos fora do seu alcance, situações de violência ou sofrimento emocional: acolha e marque precisaHumano = true (a equipe da unidade assume).',
    '- Não prometa prazos de fila, laudos ou resultados; explique como funciona.',
    '',
    'Unidades de saúde da rede:',
    unidades,
    '',
    'Perguntas frequentes da instituição:',
    faq,
    '',
    input.cidadao
      ? `Cidadão identificado: ${input.cidadao.primeiroNome}. Situação atual:\n${input.cidadao.resumo.map((r) => `- ${r}`).join('\n')}`
      : 'Cidadão não identificado pelo telefone: não há dados pessoais disponíveis; para intenções pessoais, oriente a procurar a recepção para cadastrar o telefone e autorizar o WhatsApp.',
  ].join('\n');
}

export function buildAssistantContent(historico: { de: 'CIDADAO' | 'ASSISTENTE'; texto: string }[], mensagem: string): string {
  const h = historico.length ? `Conversa recente:\n${historico.map((m) => `${m.de === 'CIDADAO' ? 'Cidadão' : 'Assistente'}: ${m.texto.slice(0, 500)}`).join('\n')}\n\n` : '';
  return `${h}Mensagem atual do cidadão: ${mensagem.slice(0, 2000)}`;
}
