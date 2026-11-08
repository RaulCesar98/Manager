// Treinamento semanal (aplicado uma vez por rodada pelo worker).
// Retorna progresso FRACIONÁRIO por atributo; o worker soma em
// training_progress e só sobe o atributo quando acumula >= 1.0.

import type { Rng } from './rng.ts';
import { overall } from './strength.ts';
import type { Attribute, Player } from './types.ts';

export type TrainingFocus =
  | 'FISICO' | 'TECNICO' | 'TATICO' | 'FINALIZACAO' | 'DEFESA' | 'GOLEIRO' | 'RECUPERACAO';

// Quais atributos cada foco coletivo trabalha
const FOCUS_ATTRS: Record<TrainingFocus, Attribute[]> = {
  FISICO: ['pace', 'stamina', 'strength'],
  TECNICO: ['passing', 'dribbling'],
  TATICO: ['vision', 'passing', 'defending'],
  FINALIZACAO: ['finishing', 'heading'],
  DEFESA: ['defending', 'heading', 'strength'],
  GOLEIRO: ['goalkeeping'],
  RECUPERACAO: [],
};

export interface TrainingContext {
  plan: Partial<Record<TrainingFocus, number>>; // intensidades, somam ~100
  individual?: { attribute: Attribute; intensity: number };
  coachSkill: number;        // técnico/auxiliar 1..100
  fitnessCoach: number;      // preparador físico 1..100
  goalkeeperCoach: number;
  physio: number;
  ctLevel: number;           // nível do CT 1..10
  ctCondition: number;       // 0..100
}

export interface TrainingResult {
  progress: Partial<Record<Attribute, number>>; // pode ser negativo (declínio por idade)
  fitnessDelta: number;
  injuryRounds: number;
}

function ageFactor(age: number): number {
  if (age <= 18) return 1.6;
  if (age <= 21) return 1.35;
  if (age <= 24) return 1.0;
  if (age <= 27) return 0.6;
  if (age <= 30) return 0.3;
  return 0.1;
}

export function applyTraining(p: Player, ctx: TrainingContext, rng: Rng): TrainingResult {
  const progress: Partial<Record<Attribute, number>> = {};
  const add = (a: Attribute, v: number) => { progress[a] = (progress[a] ?? 0) + v; };

  // Quanto ainda pode evoluir: perto do potencial, evolui pouco
  const gap = Math.max(0, p.potential - overall(p));
  const gapFactor = Math.min(1.5, gap / 12);

  const staff = 0.6 + 0.6 * (ctx.coachSkill / 100);
  const ct = (0.7 + 0.06 * ctx.ctLevel) * (0.8 + 0.2 * ctx.ctCondition / 100);
  const base = 0.12 * ageFactor(p.age) * gapFactor * staff * ct;

  const totalIntensity = Object.values(ctx.plan).reduce((s, v) => s + (v ?? 0), 0) || 1;

  // Coletivo (60% do tempo se houver treino individual, 100% se não)
  const collectiveShare = ctx.individual ? 0.6 : 1;
  for (const [focus, intensity] of Object.entries(ctx.plan) as [TrainingFocus, number][]) {
    const attrs = FOCUS_ATTRS[focus];
    if (!attrs.length) continue;
    let w = (intensity / totalIntensity) * collectiveShare;
    if (focus === 'GOLEIRO' && p.position !== 'GOL') w *= 0.1;
    if (focus === 'GOLEIRO') w *= 0.8 + 0.4 * ctx.goalkeeperCoach / 100;
    if (focus === 'FISICO') w *= 0.8 + 0.4 * ctx.fitnessCoach / 100;
    for (const a of attrs) add(a, (base * w * 3) / attrs.length);
  }

  // Individual (40% do tempo, concentrado em um atributo)
  if (ctx.individual) {
    const w = 0.4 * (0.5 + ctx.individual.intensity / 100);
    add(ctx.individual.attribute, base * w * 3);
  }

  // Declínio por idade (físico cai primeiro)
  if (p.age >= 30) {
    const decline = 0.05 * (p.age - 29);
    for (const a of ['pace', 'stamina', 'strength'] as Attribute[]) add(a, -decline * (rng.next() + 0.5));
  }

  // Desgaste e risco de lesão: treino físico pesado cansa e machuca mais
  const physicalLoad = ((ctx.plan.FISICO ?? 0) + (ctx.individual?.intensity ?? 0) * 0.3) / totalIntensity;
  const recovery = (ctx.plan.RECUPERACAO ?? 0) / totalIntensity;
  const fitnessDelta = Math.round(25 * (0.6 + recovery) + 5 * ctx.fitnessCoach / 100 - 12 * physicalLoad);
  const injuryChance = 0.012 * (0.5 + physicalLoad * 2) * (1 - ctx.physio / 200) * (p.fitness < 50 ? 1.8 : 1);
  const injuryRounds = rng.chance(injuryChance) ? rng.int(1, 3) : 0;

  return { progress, fitnessDelta, injuryRounds };
}
