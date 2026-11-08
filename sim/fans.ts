// Torcida: quantos torcedores o clube tem, como ganha/perde torcedores,
// e quanto isso vale em dinheiro (patrocínio, sócio-torcedor, produtos).
//
// Ideia central: a torcida cresce em curva "S". Cada cidade tem um mercado
// limitado, dividido entre os clubes dela; reputação nacional amplia esse
// teto. Perto do teto, crescer fica caro — ganhar títulos é o que abre espaço.

import type { DifficultyModifiers } from './settings.ts';

// ===================================================== mercado (teto)
export interface MarketInput {
  cityPopulation: number;
  clubsInCity: number;
  reputation: number;   // 1..100
}

/** Máximo de torcedores que o clube consegue atingir hoje. */
export function marketPotential(m: MarketInput): number {
  const local = (m.cityPopulation * 0.45) / Math.max(1, m.clubsInCity) ** 0.8;
  const national = (m.reputation / 100) ** 4 * 25_000_000; // rep 90 ≈ 16 mi, rep 50 ≈ 1,6 mi, rep 30 ≈ 200 mil
  return Math.round(local + national);
}

// ============================================ ações para ganhar torcida
export type CampaignKind =
  | 'REDES_SOCIAIS'      // barato, efeito pequeno e rápido
  | 'TV_RADIO'           // caro, alcance grande
  | 'ESCOLAS'            // médio, efeito lento mas cria torcedor fiel (reduz perda em fase ruim)
  | 'EXCURSAO'           // amistoso em outra cidade: aumenta o teto de mercado temporariamente
  | 'PROJETO_SOCIAL'     // custo fixo contínuo, crescimento constante + humor
  | 'INGRESSO_SOLIDARIO'; // ingresso infantil a preço simbólico: converte visitantes em torcedores

export interface CampaignDef {
  label: string;
  description: string;
  durationRounds: number | null;   // null = contínuo até cancelar
  costPerRound: (fanBase: number) => number; // centavos
  growthRate: number;              // % da torcida por rodada (escalado pelo espaço no mercado)
  moodBonus: number;               // humor por rodada
  loyalty: number;                 // reduz perdas (0..1)
  marketBoost: number;             // aumenta o teto (fração)
}

const brl = (v: number) => Math.round(v * 100);

export const CAMPAIGNS: Record<CampaignKind, CampaignDef> = {
  REDES_SOCIAIS: {
    label: 'Campanha nas redes sociais', description: 'Barata e rápida. Efeito pequeno.',
    durationRounds: 4, costPerRound: (f) => brl(10_000 + f * 0.03),
    growthRate: 0.0015, moodBonus: 0, loyalty: 0, marketBoost: 0,
  },
  TV_RADIO: {
    label: 'Comerciais em TV e rádio', description: 'Cara. Alcança muita gente de uma vez.',
    durationRounds: 3, costPerRound: (f) => brl(100_000 + f * 0.18),
    growthRate: 0.01, moodBonus: 0, loyalty: 0, marketBoost: 0.05,
  },
  ESCOLAS: {
    label: 'Visitas a escolas', description: 'Lento, mas cria torcedores fiéis que não abandonam na fase ruim.',
    durationRounds: 10, costPerRound: (f) => brl(12_000 + f * 0.02),
    growthRate: 0.0015, moodBonus: 0, loyalty: 0.3, marketBoost: 0,
  },
  EXCURSAO: {
    label: 'Amistoso em outra cidade', description: 'Leva o time para fora e amplia o mercado do clube.',
    durationRounds: 1, costPerRound: (f) => brl(150_000 + f * 0.12),
    growthRate: 0.004, moodBonus: 0, loyalty: 0, marketBoost: 0.15,
  },
  PROJETO_SOCIAL: {
    label: 'Projeto social no bairro', description: 'Custo fixo enquanto durar. Crescimento constante e torcida mais feliz.',
    durationRounds: null, costPerRound: (f) => brl(20_000 + f * 0.025),
    growthRate: 0.001, moodBonus: 0.5, loyalty: 0.15, marketBoost: 0,
  },
  INGRESSO_SOLIDARIO: {
    label: 'Ingresso infantil solidário', description: 'Crianças entram quase de graça. Perde um pouco de bilheteria.',
    durationRounds: 5, costPerRound: (f) => brl(6_000 + f * 0.05),
    growthRate: 0.002, moodBonus: 0.3, loyalty: 0.1, marketBoost: 0,
  },
};

// ================================================ crescimento por rodada
export type SeasonEvent = 'TITULO_LIGA' | 'TITULO_COPA' | 'ACESSO' | 'REBAIXAMENTO';

export interface FanRoundInput {
  fanBase: number;
  fanMood: number;                 // 0..100
  market: MarketInput;
  result?: 'V' | 'E' | 'D';        // undefined = não jogou
  isDerby?: boolean;
  winStreak: number;               // vitórias seguidas (antes desta rodada)
  homeOccupancy?: number;          // 0..1, se jogou em casa
  ticketPriceScore?: number;       // de computeGate (negativo = barato)
  activeCampaigns: CampaignKind[];
  idolsPopularity: number[];       // popularidade dos jogadores do elenco
  homegrownStarters: number;       // crias da base entre os titulares
  seasonEvents?: SeasonEvent[];    // só no fim da temporada
  difficulty: DifficultyModifiers;
}

export interface FanRoundResult {
  newFanBase: number;
  delta: number;
  breakdown: { reason: string; fans: number }[]; // para mostrar ao usuário o porquê
  marketCap: number;
}

export function updateFans(i: FanRoundInput): FanRoundResult {
  const breakdown: FanRoundResult['breakdown'] = [];
  const boost = i.activeCampaigns.reduce((s, c) => s + CAMPAIGNS[c].marketBoost, 0);
  const cap = Math.round(marketPotential(i.market) * (1 + boost));
  const room = Math.max(0, 1 - i.fanBase / cap);          // espaço no mercado (0..1)
  const loyalty = Math.min(0.6, i.activeCampaigns.reduce((s, c) => s + CAMPAIGNS[c].loyalty, 0));
  const { fanGrowth, fanPatience } = i.difficulty;

  // ganho: proporcional à torcida atual E ao espaço que sobra no mercado
  const gain = (rate: number, reason: string) => {
    const n = Math.round(i.fanBase * rate * room * fanGrowth);
    if (n) breakdown.push({ reason, fans: n });
  };
  // perda: proporcional à torcida, amortecida pela fidelidade
  const loss = (rate: number, reason: string) => {
    const n = -Math.round(i.fanBase * rate * (1 - loyalty) * fanPatience);
    if (n) breakdown.push({ reason, fans: n });
  };

  // Resultados
  const derby = i.isDerby ? 2 : 1;
  if (i.result === 'V') gain(0.0035 * derby, i.isDerby ? 'Vitória no clássico' : 'Vitória');
  if (i.result === 'D') loss(0.0012 * derby, i.isDerby ? 'Derrota no clássico' : 'Derrota');
  if (i.result === 'V' && i.winStreak >= 2) gain(0.001 * Math.min(i.winStreak, 8), `Sequência de ${i.winStreak + 1} vitórias`);

  // Estádio
  if (i.homeOccupancy !== undefined && i.homeOccupancy >= 0.9) gain(0.0015, 'Estádio lotado');
  if (i.ticketPriceScore !== undefined) {
    if (i.ticketPriceScore < -0.3) gain(0.001, 'Ingresso popular');
    if (i.ticketPriceScore > 0.5) loss(0.0008, 'Ingresso caro afasta torcedores');
  }

  // Humor geral: torcida feliz atrai, irritada abandona
  const moodRate = ((i.fanMood - 55) / 45) * 0.0012;
  if (moodRate > 0) gain(moodRate, 'Torcida animada');
  else if (moodRate < 0) loss(-moodRate, 'Torcida insatisfeita');

  // Ídolos e crias da base
  const idolPower = i.idolsPopularity.reduce((s, p) => s + Math.max(0, p - 50), 0) / 100;
  if (idolPower > 0) gain(0.0015 * idolPower, 'Ídolos no elenco');
  if (i.homegrownStarters > 0) gain(0.0004 * Math.min(i.homegrownStarters, 6), 'Crias da base no time titular');

  // Ações de marketing
  for (const c of i.activeCampaigns) gain(CAMPAIGNS[c].growthRate, CAMPAIGNS[c].label);

  // Fim de temporada
  for (const ev of i.seasonEvents ?? []) {
    if (ev === 'TITULO_LIGA') gain(0.08, 'Título da liga');
    if (ev === 'TITULO_COPA') gain(0.05, 'Título da copa');
    if (ev === 'ACESSO') gain(0.04, 'Acesso de divisão');
    if (ev === 'REBAIXAMENTO') loss(0.05, 'Rebaixamento');
  }

  const delta = breakdown.reduce((s, b) => s + b.fans, 0);
  const newFanBase = Math.max(500, i.fanBase + delta);
  return { newFanBase, delta: newFanBase - i.fanBase, breakdown, marketCap: cap };
}

// ================================================ dinheiro da torcida
export type SponsorSlot = 'MASTER' | 'COSTAS' | 'MANGA' | 'ESTADIO' | 'MATERIAL';

const SLOT_SHARE: Record<SponsorSlot, number> = {
  MASTER: 1, MATERIAL: 0.6, ESTADIO: 0.45, COSTAS: 0.35, MANGA: 0.2,
};
const TIER_FACTOR = [1, 0.6, 0.35, 0.2]; // divisão 1..4

/**
 * Valor justo de patrocínio por rodada (centavos).
 * Torcida é o fator principal: dobrar a torcida aumenta ~80% o valor.
 */
export function sponsorValuePerRound(p: {
  slot: SponsorSlot;
  fanBase: number;
  reputation: number;
  divisionTier: number;
  difficulty: DifficultyModifiers;
}): number {
  const fans = p.fanBase ** 0.85 * 1.69;               // R$ (contratos 30% maiores que na versão anterior)
  const rep = 0.6 + p.reputation / 100;
  const tier = TIER_FACTOR[Math.min(3, p.divisionTier - 1)];
  return Math.round(fans * rep * tier * SLOT_SHARE[p.slot] * p.difficulty.sponsorValue) * 100;
}

/** Bônus por vitória costuma ser ~15% do valor por rodada. */
export const winBonus = (perRound: number) => Math.round(perRound * 0.15);

/** Multa para o clube romper: 3 rodadas do valor + 10% do que falta do contrato. */
export function sponsorBreakFee(perRound: number, roundsLeft: number): number {
  return Math.round(perRound * 3 + perRound * roundsLeft * 0.1);
}

// ---------------------------------------------- sócio-torcedor
/** Preço mensal "justo" do sócio-torcedor (centavos). */
export const membershipReferencePrice = (reputation: number) =>
  Math.round((15 + reputation * 0.6) * 100);

/**
 * Quantos sócios o clube terá na próxima rodada. Converge aos poucos
 * (10% por rodada) para o alvo, que depende de humor e preço.
 */
export function updateMembers(p: {
  members: number;
  fanBase: number;
  fanMood: number;
  monthlyPrice: number;   // centavos; 0 = programa desligado
  reputation: number;
}): { members: number; revenuePerRound: number } {
  if (p.monthlyPrice <= 0) return { members: 0, revenuePerRound: 0 };
  const ratio = p.monthlyPrice / membershipReferencePrice(p.reputation);
  const priceFactor = Math.min(2, ratio ** (ratio < 1 ? -0.5 : -1.6));
  const moodFactor = 0.3 + 0.7 * (p.fanMood / 100) ** 1.5;
  const target = p.fanBase * 0.012 * priceFactor * moodFactor;
  const members = Math.round(p.members + (target - p.members) * 0.1);
  // rodadas ≈ semanais: 1 mês ≈ 4 rodadas
  return { members, revenuePerRound: Math.round((members * p.monthlyPrice) / 4) };
}

/** Venda de camisas e produtos por rodada (centavos). */
export function merchandisingPerRound(fanBase: number, reputation: number, fanMood: number): number {
  return Math.round(fanBase * 0.04 * (0.5 + reputation / 100) * (0.6 + 0.4 * fanMood / 100)) * 100;
}
