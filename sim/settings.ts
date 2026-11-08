// Configurações da sala (mundo multiplayer).
// O dono da sala edita isso no lobby; depois que a temporada começa,
// só os campos marcados como "editável em jogo" podem mudar.

export type Difficulty = 'FACIL' | 'NORMAL' | 'DIFICIL' | 'LENDARIO';
export type MatchSpeed = 'INSTANTANEA' | 'RAPIDA' | 'NORMAL' | 'LENTA';
export type HumanStart = 'ULTIMA_DIVISAO' | 'QUALQUER' | 'SORTEIO';
export type TransferWindow = 'SEMPRE' | 'JANELAS';

export interface RoomSettings {
  name: string;
  maxHumans: number;              // 1..40 (1 = modo solo contra a IA)
  isPrivate: boolean;             // exige senha/código

  structure: {
    divisions: number;            // 1..4
    clubsPerDivision: number;     // par, 8..20
    promotion: number;            // sobem por divisão
    relegation: number;           // descem por divisão
    humanStart: HumanStart;       // onde os jogadores humanos começam
  };

  rules: {
    maxSubs: 3 | 5;
    squadMin: number;             // elenco mínimo
    squadMax: number;             // elenco máximo
    transferWindow: TransferWindow;
    windowRounds: number;         // se JANELAS: rodadas abertas no início de cada turno
    wageCapPercent: number | null;// teto de salários em % da receita (null = sem teto)
    blockSpendingWhenNegative: boolean; // "fair play": saldo negativo não compra
    injuries: boolean;
    youthIntakePerSeason: boolean;
  };

  pacing: {
    // A rodada roda quando TODOS os humanos ativos clicam "Pronto".
    // Se alguém demorar, o tempo limite garante que ninguém trava a sala.
    prepTimeoutMinutes: number | null; // 1..1440, ou null = espera todos sem limite
    minPrepSeconds: number;            // espera mínima após a rodada (ver resultados), 0..600
    afkAfterMisses: number;            // estourou o prazo N vezes seguidas -> vira AFK (0 = nunca)
  };

  matchSpeed: MatchSpeed;
  difficulty: Difficulty;
}

// ---------------------------------------------------------------- padrões
export const DEFAULT_SETTINGS: RoomSettings = {
  name: 'Nova sala',
  maxHumans: 16,
  isPrivate: false,
  structure: { divisions: 2, clubsPerDivision: 20, promotion: 4, relegation: 4, humanStart: 'ULTIMA_DIVISAO' },
  rules: {
    maxSubs: 5, squadMin: 18, squadMax: 32, transferWindow: 'JANELAS', windowRounds: 4,
    wageCapPercent: null, blockSpendingWhenNegative: true, injuries: true, youthIntakePerSeason: true,
  },
  pacing: { prepTimeoutMinutes: 10, minPrepSeconds: 20, afkAfterMisses: 3 },
  matchSpeed: 'NORMAL',
  difficulty: 'NORMAL',
};

// Atalhos de ritmo para a tela de criação
export const PACING_PRESETS: Record<string, RoomSettings['pacing']> = {
  'Relâmpago (2 min)':      { prepTimeoutMinutes: 2,    minPrepSeconds: 10, afkAfterMisses: 2 },
  'Sessão ao vivo (10 min)':{ prepTimeoutMinutes: 10,   minPrepSeconds: 20, afkAfterMisses: 3 },
  'Com calma (30 min)':     { prepTimeoutMinutes: 30,   minPrepSeconds: 30, afkAfterMisses: 3 },
  'Liga longa (24 h)':      { prepTimeoutMinutes: 1440, minPrepSeconds: 60, afkAfterMisses: 3 },
  'Sem limite':             { prepTimeoutMinutes: null, minPrepSeconds: 20, afkAfterMisses: 0 },
};

// ------------------------------------------------------------ dificuldade
// Vale para a sala inteira (é multiplayer: todos jogam com as mesmas regras).
export interface DifficultyModifiers {
  startingBalance: number;   // multiplica o caixa inicial dos clubes humanos
  aiStrength: number;        // força dos clubes controlados pela IA em campo
  sponsorValue: number;      // valor das ofertas de patrocínio
  fanGrowth: number;         // ganho de torcedores
  fanPatience: number;       // multiplica perdas de humor/torcida (maior = torcida mais exigente)
  injuryRate: number;
  wageDemands: number;       // salário pedido por jogadores e staff
  aiTransferAggression: number; // quanto a IA disputa jogadores no mercado
}

export const DIFFICULTY: Record<Difficulty, DifficultyModifiers> = {
  FACIL:    { startingBalance: 1.6,  aiStrength: 0.95, sponsorValue: 1.3,  fanGrowth: 1.3,  fanPatience: 0.7,  injuryRate: 0.7,  wageDemands: 0.85, aiTransferAggression: 0.6 },
  NORMAL:   { startingBalance: 1.0,  aiStrength: 1.0,  sponsorValue: 1.0,  fanGrowth: 1.0,  fanPatience: 1.0,  injuryRate: 1.0,  wageDemands: 1.0,  aiTransferAggression: 1.0 },
  DIFICIL:  { startingBalance: 0.7,  aiStrength: 1.04, sponsorValue: 0.85, fanGrowth: 0.85, fanPatience: 1.25, injuryRate: 1.15, wageDemands: 1.15, aiTransferAggression: 1.3 },
  LENDARIO: { startingBalance: 0.45, aiStrength: 1.08, sponsorValue: 0.7,  fanGrowth: 0.7,  fanPatience: 1.5,  injuryRate: 1.3,  wageDemands: 1.3,  aiTransferAggression: 1.6 },
};

// --------------------------------------------------------- velocidade
// Só afeta a EXIBIÇÃO do "ao vivo". O resultado é calculado na hora pelo
// servidor; o cliente revela os eventos no ritmo escolhido.
export const MS_PER_MATCH_MINUTE: Record<MatchSpeed, number> = {
  INSTANTANEA: 0,    // mostra o placar final direto
  // 99 minutos de jogo (90 + acréscimos); cada velocidade é 15 s mais curta que a versão anterior
  RAPIDA: 250,       // ~25 s por jogo
  NORMAL: 1050,      // ~1 min 45 s por jogo
  LENTA: 2850,       // ~4 min 40 s por jogo
};

/** Momento (ms desde o início da exibição) em que cada evento aparece. */
export function eventRevealAt(minute: number, speed: MatchSpeed, halftimePauseMs = 5000): number {
  const ms = MS_PER_MATCH_MINUTE[speed];
  if (ms === 0) return 0;
  return minute * ms + (minute > 45 ? halftimePauseMs : 0);
}

// ------------------------------------------------------------ modo solo
export const isSolo = (s: RoomSettings) => s.maxHumans === 1;

/**
 * Ajusta regras que não fazem sentido no modo solo. O servidor chama isto
 * antes de salvar a sala: sozinho, o jogo sempre espera você (sem tempo
 * limite nem AFK) e não há senha nem convite.
 */
export function normalizeSettings(s: RoomSettings): RoomSettings {
  if (!isSolo(s)) return s;
  return {
    ...s,
    isPrivate: false,
    pacing: { ...s.pacing, prepTimeoutMinutes: null, afkAfterMisses: 0 },
  };
}

// ---------------------------------------------------------- validação
export function validateSettings(s: RoomSettings): string[] {
  const e: string[] = [];
  const { structure: st, rules: r, pacing: p } = s;
  if (!s.name.trim() || s.name.length > 40) e.push('Nome da sala deve ter entre 1 e 40 caracteres.');
  if (!Number.isInteger(s.maxHumans) || s.maxHumans < 1 || s.maxHumans > 40) e.push('Jogadores humanos: entre 1 (solo) e 40.');
  if (st.divisions < 1 || st.divisions > 4) e.push('Divisões: entre 1 e 4.');
  if (st.clubsPerDivision < 8 || st.clubsPerDivision > 20 || st.clubsPerDivision % 2)
    e.push('Clubes por divisão: número par entre 8 e 20.');
  if (s.maxHumans > st.divisions * st.clubsPerDivision) e.push('Há mais vagas humanas que clubes.');
  if (st.humanStart === 'ULTIMA_DIVISAO' && s.maxHumans > st.clubsPerDivision)
    e.push('Começando na última divisão, o máximo de humanos é o número de clubes por divisão.');
  if (st.divisions > 1) {
    if (st.promotion < 1 || st.promotion > st.clubsPerDivision / 4) e.push('Acesso: entre 1 e 1/4 dos clubes.');
    if (st.relegation !== st.promotion) e.push('Rebaixados e promovidos precisam ser iguais para as divisões manterem o tamanho.');
  }
  if (r.squadMin < 16 || r.squadMax > 40 || r.squadMin > r.squadMax) e.push('Elenco: mínimo ≥ 16, máximo ≤ 40.');
  if (r.transferWindow === 'JANELAS' && (r.windowRounds < 1 || r.windowRounds > st.clubsPerDivision - 1))
    e.push('Janela de transferências: entre 1 rodada e o turno inteiro.');
  if (r.wageCapPercent !== null && (r.wageCapPercent < 30 || r.wageCapPercent > 100))
    e.push('Teto salarial: entre 30% e 100% da receita.');
  if (p.prepTimeoutMinutes !== null && (p.prepTimeoutMinutes < 1 || p.prepTimeoutMinutes > 1440))
    e.push('Tempo limite de preparação: de 1 minuto a 24 horas (ou sem limite).');
  if (p.minPrepSeconds < 0 || p.minPrepSeconds > 600) e.push('Espera mínima: de 0 a 10 minutos.');
  if (p.prepTimeoutMinutes !== null && p.minPrepSeconds > p.prepTimeoutMinutes * 60)
    e.push('A espera mínima não pode ser maior que o tempo limite.');
  if (p.afkAfterMisses < 0 || p.afkAfterMisses > 10) e.push('AFK: de 0 (nunca) a 10 prazos perdidos.');
  if (p.prepTimeoutMinutes === null && p.afkAfterMisses > 0)
    e.push('Sem tempo limite ninguém perde prazo: deixe AFK em 0.');
  return e;
}

/** Campos que o dono pode mudar depois que a temporada começou. */
export const EDITABLE_IN_GAME: string[] = [
  'name', 'maxHumans', 'isPrivate', 'pacing.prepTimeoutMinutes', 'pacing.minPrepSeconds',
  'pacing.afkAfterMisses', 'matchSpeed',
];
// Estrutura, regras e dificuldade só valem a partir da próxima temporada.

// ------------------------------------------------------ "todos prontos"
export interface HumanSlot {
  userId: string;
  ready: boolean;
  afk: boolean;        // perdeu prazos demais: a sala não espera mais por ele
  online?: boolean;    // só informativo para a UI
}

export type RoundDecision =
  | { run: false; waitingFor: string[]; deadline: Date | null; minPrepEndsAt: Date }
  | { run: true; reason: 'TODOS_PRONTOS' | 'TEMPO_ESGOTADO' | 'SO_IA'; missed: string[] };

/**
 * Chamado pelo servidor quando alguém clica "Pronto" e por um timer a cada
 * poucos segundos. `prepStartedAt` = quando a fase de preparação começou
 * (fim da exibição da rodada anterior).
 *
 * - Todos os humanos ativos prontos + espera mínima cumprida -> roda.
 * - Tempo limite estourado -> roda; quem não confirmou entra em `missed`
 *   (joga com a última escalação salva ou a escalação automática).
 * - Jogadores AFK não são esperados. Voltam a contar assim que clicarem "Pronto".
 */
export function decideRound(params: {
  now: Date;
  prepStartedAt: Date;
  humans: HumanSlot[];
  settings: RoomSettings;
}): RoundDecision {
  const { now, prepStartedAt, humans, settings: { pacing: p } } = params;
  const minPrepEndsAt = new Date(prepStartedAt.getTime() + p.minPrepSeconds * 1000);
  const deadline = p.prepTimeoutMinutes === null ? null
    : new Date(prepStartedAt.getTime() + p.prepTimeoutMinutes * 60_000);

  const active = humans.filter((h) => !h.afk || h.ready);
  const waitingFor = active.filter((h) => !h.ready).map((h) => h.userId);
  const minOk = now >= minPrepEndsAt;

  if (active.length === 0 && minOk) return { run: true, reason: 'SO_IA', missed: [] };
  if (waitingFor.length === 0 && minOk) return { run: true, reason: 'TODOS_PRONTOS', missed: [] };
  if (deadline && now >= deadline) return { run: true, reason: 'TEMPO_ESGOTADO', missed: waitingFor };
  return { run: false, waitingFor, deadline, minPrepEndsAt };
}

/**
 * Atualiza contadores de prazo perdido depois que a rodada roda.
 * Retorna quem passou a ser AFK e quem deixou de ser.
 */
export function updateAfk(
  missedCount: Map<string, number>,
  humans: HumanSlot[],
  missed: string[],
  settings: RoomSettings,
): { nowAfk: string[]; back: string[] } {
  const limit = settings.pacing.afkAfterMisses;
  const nowAfk: string[] = [], back: string[] = [];
  for (const h of humans) {
    if (missed.includes(h.userId)) {
      const n = (missedCount.get(h.userId) ?? 0) + 1;
      missedCount.set(h.userId, n);
      if (limit > 0 && n >= limit && !h.afk) nowAfk.push(h.userId);
    } else if (h.ready) {
      missedCount.set(h.userId, 0);
      if (h.afk) back.push(h.userId);
    }
  }
  return { nowAfk, back };
}

/** Quanto dura a exibição "ao vivo" da rodada (a preparação começa depois). */
export function liveDurationMs(speed: MatchSpeed, halftimePauseMs = 5000): number {
  const ms = MS_PER_MATCH_MINUTE[speed];
  return ms === 0 ? 0 : 95 * ms + halftimePauseMs;
}
