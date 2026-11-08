// Bilheteria, público e humor da torcida.
// Valores em CENTAVOS, como no banco.

export type Sector = 'GERAL' | 'ARQUIBANCADA' | 'CADEIRA' | 'CAMAROTE';

export interface StadiumSector {
  sector: Sector;
  capacity: number;
  ticketPrice: number;     // centavos
  comfort: number;         // 1..100
}

export interface GateInput {
  sectors: StadiumSector[];
  capacityBlocked: number; // lugares fechados por obra
  fanBase: number;
  fanMood: number;         // 0..100
  reputation: number;      // 1..100 do mandante
  opponentReputation: number;
  isDerby: boolean;
  stadiumCondition: number; // 0..100 (estádio mal conservado afasta público)
}

// Preço "justo" de referência por setor para um clube de reputação 50 (R$)
const REFERENCE_PRICE_BRL: Record<Sector, number> = {
  GERAL: 30, ARQUIBANCADA: 60, CADEIRA: 120, CAMAROTE: 400,
};
// Parcela da torcida que procura cada setor
const DEMAND_SHARE: Record<Sector, number> = {
  GERAL: 0.45, ARQUIBANCADA: 0.35, CADEIRA: 0.15, CAMAROTE: 0.05,
};

export function referencePrice(sector: Sector, reputation: number): number {
  // clube maior pode cobrar mais: rep 20 -> 0.7x, rep 50 -> 1x, rep 90 -> 1.6x
  return Math.round(REFERENCE_PRICE_BRL[sector] * 100 * (0.5 + reputation / 100) ** 1.15);
}

export interface GateResult {
  attendance: number;
  revenue: number;
  bySector: { sector: Sector; sold: number; revenue: number; demand: number }[];
  moodDelta: number;       // efeito do preço na torcida
  moodReason?: string;
}

export function computeGate(g: GateInput): GateResult {
  // Interesse geral no jogo
  const moodFactor = 0.3 + 0.7 * (g.fanMood / 100);
  const opponentPull = 0.85 + 0.3 * (g.opponentReputation / 100) + (g.isDerby ? 0.35 : 0);
  const conditionFactor = 0.7 + 0.3 * (g.stadiumCondition / 100);
  // só uma fração da torcida vai a cada jogo (~1,5% com humor e adversário médios)
  const interested = g.fanBase * 0.015 * moodFactor * opponentPull * conditionFactor;

  const totalCap = g.sectors.reduce((s, x) => s + x.capacity, 0) || 1;
  let blockedLeft = g.capacityBlocked;
  let attendance = 0, revenue = 0, priceScore = 0;
  const bySector: GateResult['bySector'] = [];

  for (const s of g.sectors) {
    const ref = referencePrice(s.sector, g.reputation);
    // Elasticidade: cada 10% acima da referência derruba ~13% da procura
    const priceRatio = Math.max(0.05, s.ticketPrice / ref);
    const elasticity = priceRatio < 1 ? 0.6 : 1.3;
    const comfort = 0.85 + 0.3 * (s.comfort / 100);
    const demand = Math.round(interested * DEMAND_SHARE[s.sector] * comfort * priceRatio ** -elasticity);

    // obra bloqueia lugares proporcionalmente
    const blocked = Math.min(blockedLeft, Math.round(g.capacityBlocked * (s.capacity / totalCap)));
    blockedLeft -= blocked;
    const available = Math.max(0, s.capacity - blocked);
    const sold = Math.min(available, demand);

    attendance += sold;
    revenue += sold * s.ticketPrice;
    priceScore += (priceRatio - 1) * DEMAND_SHARE[s.sector];
    bySector.push({ sector: s.sector, sold, revenue: sold * s.ticketPrice, demand });
  }

  // Torcida reage ao preço (média ponderada de quão acima/abaixo do justo)
  let moodDelta = 0, moodReason: string | undefined;
  if (priceScore > 0.5) { moodDelta = -3; moodReason = 'Ingressos muito caros'; }
  else if (priceScore > 0.2) { moodDelta = -1; moodReason = 'Ingressos caros'; }
  else if (priceScore < -0.3) { moodDelta = 1; moodReason = 'Ingressos populares'; }

  return { attendance, revenue, bySector, moodDelta, moodReason };
}

/** Humor da torcida depois do jogo. */
export function moodAfterMatch(params: {
  goalsFor: number;
  goalsAgainst: number;
  ourStrength: number;     // overall médio
  theirStrength: number;
  isDerby: boolean;
  currentMood: number;
}): { delta: number; reason: string } {
  const { goalsFor: gf, goalsAgainst: ga, isDerby } = params;
  const underdog = params.theirStrength - params.ourStrength; // >0 = éramos piores
  let delta: number, reason: string;
  if (gf > ga) {
    delta = 3 + (underdog > 5 ? 2 : 0) + (gf - ga >= 3 ? 1 : 0);
    reason = underdog > 5 ? 'Vitória contra time mais forte' : 'Vitória';
  } else if (gf === ga) {
    delta = underdog > 5 ? 1 : underdog < -5 ? -2 : 0;
    reason = 'Empate';
  } else {
    delta = -3 - (ga - gf >= 3 ? 3 : 0) - (underdog < -5 ? 2 : 0);
    reason = ga - gf >= 3 ? 'Goleada sofrida' : 'Derrota';
  }
  if (isDerby) { delta *= 2; reason += ' no clássico'; }
  // puxa levemente para o neutro (60) para o humor não travar nos extremos
  delta += Math.round((60 - params.currentMood) * 0.03);
  return { delta, reason };
}

/** Vender um ídolo irrita a torcida. */
export function moodOnSale(popularity: number): number {
  return -Math.round(popularity / 12);
}

/** Manutenção por rodada de uma instalação (estádio, CT, base, depto. médico), em centavos. */
export function maintenancePerRound(level: number): number {
  return level * level * 2_000 * 100; // nível 2 ≈ R$ 8 mil, nível 6 ≈ R$ 72 mil, nível 10 ≈ R$ 200 mil
}

/** Valor de mercado simples: overall, idade e potencial. */
/**
 * Valor de mercado (centavos): ~2,5 temporadas do salário de um jogador desse nível,
 * ajustado por idade e potencial. Mesma curva de salaryFor (worldgen), para que passe
 * e salário fiquem coerentes: ovr 55 ≈ R$ 0,6 mi, ovr 65 ≈ R$ 2,4 mi, ovr 75 ≈ R$ 11 mi.
 */
export function marketValue(overall: number, age: number, potential: number): number {
  const ageFactor = age <= 21 ? 1.5 : age <= 25 ? 1.25 : age <= 29 ? 1 : age <= 32 ? 0.55 : 0.25;
  const potBonus = age <= 23 ? Math.max(0, potential - overall) * 0.03 : 0;
  const weekly = Math.exp((overall - 40) / 5.75) * 345;   // R$ por semana (igual a salaryFor)
  const base = weekly * 38 * 2.5;
  return Math.round(base * ageFactor * (1 + potBonus) / 1000) * 1000 * 100;
}
