// Demonstração e calibragem: node --experimental-strip-types sim/demo.ts
import { computeGate, marketValue, moodAfterMatch } from './economy.ts';
import { simulateMatch } from './match.ts';
import { Rng } from './rng.ts';
import { overall } from './strength.ts';
import { applyTraining } from './training.ts';
import { ATTRIBUTES, type Attribute, type Player, type Position, type Staff, type TeamSetup } from './types.ts';
import { generateYouthIntake } from './youth.ts';

let idSeq = 1;
const nextId = () => idSeq++;

function makePlayer(rng: Rng, pos: Position, level: number, name: string): Player {
  const fav: Record<Position, Attribute[]> = {
    GOL: ['goalkeeping'], ZAG: ['defending', 'heading', 'strength'], LAT: ['pace', 'defending', 'stamina'],
    VOL: ['defending', 'passing', 'stamina'], MEI: ['passing', 'vision', 'dribbling'], ATA: ['finishing', 'pace', 'dribbling'],
  };
  const attrs = {} as Record<Attribute, number>;
  for (const a of ATTRIBUTES) {
    let v = level - 12 + rng.gauss() * 5;
    if (fav[pos].includes(a)) v += 14;
    if (a === 'goalkeeping' && pos !== 'GOL') v = 10;
    attrs[a] = Math.round(Math.max(1, Math.min(99, v)));
  }
  return { id: nextId(), name, age: rng.int(19, 32), position: pos, attrs,
    potential: Math.min(99, level + rng.int(0, 15)), form: 50, fitness: 100, morale: 60, popularity: 10 };
}

const FORMATION: Position[] = ['GOL', 'LAT', 'ZAG', 'ZAG', 'LAT', 'VOL', 'VOL', 'MEI', 'MEI', 'ATA', 'ATA'];
const BENCH: Position[] = ['GOL', 'ZAG', 'LAT', 'VOL', 'MEI', 'ATA', 'ATA'];
const staff = (q: number): Staff => ({
  coachTactics: q, coachMotivation: q, fitnessCoach: q, goalkeeperCoach: q, doctor: q, physio: q, youthCoach: q,
});

function makeTeam(clubId: number, name: string, level: number, seed: number): TeamSetup {
  const rng = new Rng(seed);
  return {
    clubId, name, mentality: 0, fanMood: 60, staff: staff(level),
    lineup: FORMATION.map((pos, i) => ({ player: makePlayer(rng, pos, level, `${name.slice(0, 3)}-${pos}${i}`), role: pos })),
    bench: BENCH.map((pos, i) => makePlayer(rng, pos, level - 5, `${name.slice(0, 3)}-R${pos}${i}`)),
  };
}

const avgOverall = (t: TeamSetup) => t.lineup.reduce((s, x) => s + overall(x.player), 0) / t.lineup.length;

// ---------------------------------------------------------------- 1 jogo
const tigres = makeTeam(1, 'Tigres FC', 68, 11);
const aguias = makeTeam(2, 'Águias EC', 66, 22);
console.log(`\n=== Partida de exemplo (overall ${avgOverall(tigres).toFixed(1)} x ${avgOverall(aguias).toFixed(1)}) ===`);
const r = simulateMatch(tigres, aguias, 2026);
for (const e of r.events) if (e.type !== 'CHANCE') console.log(`${String(e.minute).padStart(2)}'  ${e.text}`);
console.log(`Posse ${r.stats.possessionHome}% x ${100 - r.stats.possessionHome}% | Finalizações ${r.stats.shotsHome} x ${r.stats.shotsAway}`);
const best = [...r.players].sort((a, b) => b.rating - a.rating)[0];
console.log(`Melhor em campo: jogador #${best.playerId} nota ${best.rating}`);

// ------------------------------------------------------ calibragem em massa
function batch(a: TeamSetup, b: TeamSetup, n: number) {
  let hw = 0, d = 0, aw = 0, goals = 0, reds = 0, inj = 0;
  for (let i = 0; i < n; i++) {
    const m = simulateMatch(a, b, 1000 + i);
    goals += m.homeGoals + m.awayGoals;
    if (m.homeGoals > m.awayGoals) hw++; else if (m.homeGoals === m.awayGoals) d++; else aw++;
    reds += m.events.filter((e) => e.type === 'VERMELHO').length;
    inj += m.events.filter((e) => e.type === 'LESAO').length;
  }
  const pct = (x: number) => ((100 * x) / n).toFixed(0) + '%';
  return `mandante ${pct(hw)} | empate ${pct(d)} | visitante ${pct(aw)} | gols/jogo ${(goals / n).toFixed(2)} | vermelhos/jogo ${(reds / n).toFixed(2)} | lesões/jogo ${(inj / n).toFixed(2)}`;
}
const N = 3000;
console.log(`\n=== Calibragem (${N} jogos cada) ===`);
const eq1 = makeTeam(10, 'Igual A', 65, 101), eq2 = makeTeam(11, 'Igual B', 65, 101);
console.log('Times iguais        :', batch(eq1, eq2, N));
const strong = makeTeam(12, 'Forte', 78, 202), weak = makeTeam(13, 'Fraco', 58, 303);
console.log('Forte (casa) x Fraco:', batch(strong, weak, N));
console.log('Fraco (casa) x Forte:', batch(weak, strong, N));

// --------------------------------------------------------------- bilheteria
console.log('\n=== Bilheteria: efeito do preço do ingresso ===');
for (const mult of [0.5, 1, 1.5, 2.5]) {
  const g = computeGate({
    sectors: [
      { sector: 'GERAL', capacity: 15000, ticketPrice: Math.round(3000 * mult), comfort: 30 },
      { sector: 'ARQUIBANCADA', capacity: 12000, ticketPrice: Math.round(6000 * mult), comfort: 50 },
      { sector: 'CADEIRA', capacity: 5000, ticketPrice: Math.round(12000 * mult), comfort: 70 },
      { sector: 'CAMAROTE', capacity: 500, ticketPrice: Math.round(40000 * mult), comfort: 95 },
    ],
    capacityBlocked: 0, fanBase: 1_400_000, fanMood: 60, reputation: 50, opponentReputation: 55,
    isDerby: false, stadiumCondition: 90,
  });
  console.log(`Preço x${mult.toFixed(1)}: público ${g.attendance.toLocaleString('pt-BR')} | renda R$ ${(g.revenue / 100).toLocaleString('pt-BR')} | torcida ${g.moodDelta >= 0 ? '+' : ''}${g.moodDelta} ${g.moodReason ?? ''}`);
}
console.log('Torcida após derrota no clássico:', moodAfterMatch({ goalsFor: 0, goalsAgainst: 2, ourStrength: 65, theirStrength: 66, isDerby: true, currentMood: 60 }));

// ------------------------------------------------------------ treino + base
console.log('\n=== Uma temporada (38 rodadas) de treino para um jovem de 18 anos ===');
const rng = new Rng(7);
const kid = makePlayer(rng, 'ATA', 52, 'Joia da Base');
kid.age = 18; kid.potential = 82;
const before = overall(kid);
const acc: Partial<Record<Attribute, number>> = {};
let injuries = 0;
for (let round = 0; round < 38; round++) {
  const res = applyTraining(kid, {
    plan: { FINALIZACAO: 40, TECNICO: 30, FISICO: 20, RECUPERACAO: 10 },
    individual: { attribute: 'finishing', intensity: 70 },
    coachSkill: 70, fitnessCoach: 60, goalkeeperCoach: 50, physio: 60, ctLevel: 5, ctCondition: 90,
  }, rng);
  if (res.injuryRounds) injuries++;
  for (const [a, v] of Object.entries(res.progress) as [Attribute, number][]) {
    acc[a] = (acc[a] ?? 0) + v;
    while ((acc[a] ?? 0) >= 1) { kid.attrs[a] = Math.min(99, kid.attrs[a] + 1); acc[a]! -= 1; }
  }
}
console.log(`Overall ${before} -> ${overall(kid)} | finalização final ${kid.attrs.finishing} | lesões no treino: ${injuries}`);
console.log(`Valor de mercado: R$ ${(marketValue(overall(kid), 19, kid.potential) / 100).toLocaleString('pt-BR')}`);

console.log('\n=== Peneira da base (nível 3 vs nível 9) ===');
for (const lvl of [3, 9]) {
  const intake = generateYouthIntake(lvl, 60, new Rng(lvl * 99), nextId);
  const s = intake.map((p) => `${p.position} ov${overall(p)}/pot${p.potential}`).join(', ');
  console.log(`Base nível ${lvl}: ${intake.length} jogadores -> ${s}`);
}
