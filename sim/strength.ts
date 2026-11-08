// Cálculo de força: transforma atributos individuais em números de setor
// (goleiro, defesa, meio, ataque) que o motor da partida usa.

import type { Attribute, LineupSlot, Player, Position, TeamSetup } from './types.ts';

// Peso de cada atributo por função em campo (cada linha soma 1.0)
const ROLE_WEIGHTS: Record<Position, Partial<Record<Attribute, number>>> = {
  GOL: { goalkeeping: 0.75, pace: 0.05, strength: 0.1, vision: 0.1 },
  ZAG: { defending: 0.4, heading: 0.2, strength: 0.2, pace: 0.1, passing: 0.1 },
  LAT: { defending: 0.3, pace: 0.3, stamina: 0.15, passing: 0.15, dribbling: 0.1 },
  VOL: { defending: 0.3, passing: 0.25, stamina: 0.2, strength: 0.15, vision: 0.1 },
  MEI: { passing: 0.3, vision: 0.3, dribbling: 0.2, finishing: 0.1, stamina: 0.1 },
  ATA: { finishing: 0.4, dribbling: 0.2, pace: 0.2, heading: 0.1, strength: 0.1 },
};

// Penalidade por jogar fora de posição
const SIMILAR: Partial<Record<Position, Position[]>> = {
  ZAG: ['LAT', 'VOL'], LAT: ['ZAG', 'MEI'], VOL: ['ZAG', 'MEI'],
  MEI: ['VOL', 'ATA', 'LAT'], ATA: ['MEI'],
};
export function positionFactor(natural: Position, role: Position): number {
  if (natural === role) return 1;
  if (natural === 'GOL' || role === 'GOL') return 0.35;
  return SIMILAR[natural]?.includes(role) ? 0.88 : 0.72;
}

/** Nota "crua" de um jogador numa função, só pelos atributos. */
export function roleRating(p: Player, role: Position): number {
  const w = ROLE_WEIGHTS[role];
  let r = 0;
  for (const k in w) r += p.attrs[k as Attribute] * (w[k as Attribute] ?? 0);
  return r;
}

/** Overall usado na UI e no cálculo de evolução/valor de mercado. */
export function overall(p: Player): number {
  return Math.round(roleRating(p, p.position));
}

/** Nota efetiva no momento: inclui posição, cansaço, forma e moral. */
export function effectiveRating(slot: LineupSlot, fitness: number): number {
  const p = slot.player;
  const condition = 0.6 + 0.4 * (fitness / 100);
  const mood = 0.92 + 0.08 * (p.form / 100) + 0.05 * (p.morale / 100);
  return roleRating(p, slot.role) * positionFactor(p.position, slot.role) * condition * mood;
}

// Quanto cada função contribui para cada setor
const SECTOR_SHARE: Record<Position, { def: number; mid: number; att: number }> = {
  GOL: { def: 0, mid: 0, att: 0 },
  ZAG: { def: 1.0, mid: 0.1, att: 0.05 },
  LAT: { def: 0.6, mid: 0.4, att: 0.3 },
  VOL: { def: 0.5, mid: 0.8, att: 0.1 },
  MEI: { def: 0.1, mid: 1.0, att: 0.5 },
  ATA: { def: 0.0, mid: 0.2, att: 1.0 },
};

export interface SectorStrength {
  gk: number;
  def: number;
  mid: number;
  att: number;
}

/**
 * Força por setor. Usa SOMA ponderada (não média): jogar com 10 depois de
 * uma expulsão reduz a força naturalmente.
 * `fitness` mapeia playerId -> fôlego atual; `onPitch` são os ativos.
 */
export function sectorStrength(
  team: TeamSetup,
  onPitch: LineupSlot[],
  fitness: Map<number, number>,
  isHome: boolean,
): SectorStrength {
  let gk = 20, def = 0, mid = 0, att = 0;
  for (const s of onPitch) {
    const r = effectiveRating(s, fitness.get(s.player.id) ?? 100);
    if (s.role === 'GOL') {
      // treinador de goleiros dá até +5%
      gk = r * (1 + team.staff.goalkeeperCoach / 2000);
      continue;
    }
    const sh = SECTOR_SHARE[s.role];
    def += r * sh.def;
    mid += r * sh.mid;
    att += r * sh.att;
  }

  // Técnico: tática bem montada vale até +6%
  const coach = 1 + team.staff.coachTactics / 1700;
  // Mando de campo: 1% a 6% dependendo do humor da torcida
  const home = isHome ? 1.01 + 0.05 * (team.fanMood / 100) : 1;
  // Mentalidade: troca defesa por ataque
  const m = team.mentality;
  const attMul = 1 + 0.07 * m;
  const defMul = 1 - 0.06 * m;

  return {
    gk: gk * coach * home,
    def: def * coach * home * defMul,
    mid: mid * coach * home,
    att: att * coach * home * attMul,
  };
}
