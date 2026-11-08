// Simula uma temporada inteira de um mundo gerado: partidas, bilheteria,
// patrocínio, sócio-torcedor, produtos, salários e evolução da torcida.
// Roda duas vezes com a MESMA semente: na segunda, um clube investe em
// ações para ganhar torcedores — dá para ver o efeito isolado.
//   node --experimental-strip-types sim/demo-temporada.ts

import { computeGate, maintenancePerRound, moodAfterMatch } from './economy.ts';
import {
  CAMPAIGNS, merchandisingPerRound, sponsorValuePerRound, updateFans, updateMembers, winBonus,
  type CampaignKind, type SeasonEvent,
} from './fans.ts';
import { simulateMatch } from './match.ts';
import {
  DEFAULT_SETTINGS, DIFFICULTY, MS_PER_MATCH_MINUTE, decideRound, liveDurationMs, normalizeSettings, updateAfk, validateSettings,
  type HumanSlot, type RoomSettings,
} from './settings.ts';
import { overall } from './strength.ts';
import type { Position, Staff, TeamSetup } from './types.ts';
import { generateWorld, type GenClub, type GenPlayer, type WorldData } from './worldgen.ts';

const fmt = (n: number) => Math.round(n).toLocaleString('pt-BR');
const brl = (c: number) => 'R$ ' + fmt(c / 100);

// ------------------------------------------------------------ escalação
const FORMATION: Position[] = ['GOL', 'LAT', 'ZAG', 'ZAG', 'LAT', 'VOL', 'VOL', 'MEI', 'MEI', 'ATA', 'ATA'];
function buildTeam(w: WorldData, club: GenClub, mood: number): TeamSetup {
  const squad = w.players.filter((p) => p.clubId === club.id && !p.isYouth).sort((a, b) => overall(b) - overall(a));
  const used = new Set<number>();
  const pick = (pos: Position) => {
    const p = squad.find((x) => x.position === pos && !used.has(x.id)) ?? squad.find((x) => !used.has(x.id))!;
    used.add(p.id);
    return p;
  };
  const lineup = FORMATION.map((role) => ({ player: pick(role), role }));
  const bench = [pick('GOL'), ...squad.filter((p) => !used.has(p.id)).slice(0, 6)];
  const st = (role: string) => w.staff.find((s) => s.clubId === club.id && s.role === role)?.skill ?? 0;
  const staff: Staff = {
    coachTactics: st('TECNICO'), coachMotivation: st('TECNICO'), fitnessCoach: st('PREP_FISICO'),
    goalkeeperCoach: st('TREINADOR_GOLEIROS'), doctor: st('MEDICO'), physio: st('FISIOTERAPEUTA'),
    youthCoach: st('TREINADOR_BASE'),
  };
  return { clubId: club.id, name: club.name, lineup, bench, mentality: 0, staff, fanMood: mood, isAI: true };
}

// ------------------------------------------------------------ temporada
interface ClubState {
  fanBase: number; mood: number; members: number; balance: number; streak: number;
  pts: number; gf: number; ga: number; w: number; d: number; l: number;
  income: Record<string, number>; expense: Record<string, number>;
  reasons: Map<string, number>;
}

function runSeason(world: WorldData, plan: Map<number, (round: number) => CampaignKind[]>) {
  const diff = DIFFICULTY[world.settings.difficulty];
  const S = new Map<number, ClubState>();
  for (const c of world.clubs) S.set(c.id, {
    fanBase: c.fanBase, mood: c.fanMood, members: 0, balance: c.balance, streak: 0,
    pts: 0, gf: 0, ga: 0, w: 0, d: 0, l: 0, income: {}, expense: {}, reasons: new Map(),
  });
  const add = (o: Record<string, number>, k: string, v: number) => { o[k] = (o[k] ?? 0) + v; };
  const cityOf = (c: GenClub) => world.cities.find((x) => x.id === c.cityId)!;
  const clubsInCity = (c: GenClub) => world.clubs.filter((x) => x.cityId === c.cityId).length;
  const wages = new Map(world.clubs.map((c) => [c.id,
    world.players.filter((p) => p.clubId === c.id).reduce((s, p) => s + p.weeklySalary, 0) +
    world.staff.filter((s) => s.clubId === c.id).reduce((s, x) => s + x.weeklySalary, 0)]));
  const sponsorPay = new Map(world.clubs.map((c) => [c.id,
    world.sponsorships.filter((s) => s.clubId === c.id).reduce((s, x) => s + x.perRound, 0)]));

  const rounds = Math.max(...world.fixtures.map((f) => f.round));
  for (let round = 1; round <= rounds; round++) {
    const played = new Map<number, { res: 'V' | 'E' | 'D'; derby: boolean; occ?: number; price?: number }>();

    for (const f of world.fixtures.filter((x) => x.round === round)) {
      const home = world.clubs.find((c) => c.id === f.homeId)!, away = world.clubs.find((c) => c.id === f.awayId)!;
      const sh = S.get(home.id)!, sa = S.get(away.id)!;
      const m = simulateMatch(buildTeam(world, home, sh.mood), buildTeam(world, away, sa.mood),
        world.seed * 1000 + round * 50 + f.homeId, { maxSubs: world.settings.rules.maxSubs, injuryRate: diff.injuryRate });
      const derby = home.rivalId === away.id || away.rivalId === home.id;

      // bilheteria (o mandante fica com a renda)
      const campaignsHome = plan.get(home.id)?.(round) ?? [];
      const gate = computeGate({
        sectors: home.sectors, capacityBlocked: 0, fanBase: sh.fanBase, fanMood: sh.mood,
        reputation: home.reputation, opponentReputation: away.reputation, isDerby: derby, stadiumCondition: 90,
      });
      const ticketIncome = campaignsHome.includes('INGRESSO_SOLIDARIO') ? gate.revenue * 0.95 : gate.revenue;
      sh.balance += ticketIncome; add(sh.income, 'Bilheteria', ticketIncome);
      sh.mood += gate.moodDelta;
      const cap = home.sectors.reduce((s, x) => s + x.capacity, 0);

      for (const [club, st, gf, ga, isHome] of [[home, sh, m.homeGoals, m.awayGoals, true], [away, sa, m.awayGoals, m.homeGoals, false]] as const) {
        const res = gf > ga ? 'V' : gf === ga ? 'E' : 'D';
        st.gf += gf; st.ga += ga;
        if (res === 'V') { st.w++; st.pts += 3; } else if (res === 'E') { st.d++; st.pts++; } else st.l++;
        const avg = (c: GenClub) => world.players.filter((p) => p.clubId === c.id && !p.isYouth).map(overall).sort((a, b) => b - a).slice(0, 11).reduce((s, x) => s + x, 0) / 11;
        const mood = moodAfterMatch({ goalsFor: gf, goalsAgainst: ga, ourStrength: avg(club), theirStrength: avg(isHome ? away : home), isDerby: derby, currentMood: st.mood });
        st.mood = Math.max(0, Math.min(100, st.mood + Math.round(mood.delta * (mood.delta < 0 ? diff.fanPatience : 1))));
        played.set(club.id, { res, derby, occ: isHome ? gate.attendance / cap : undefined, price: isHome ? (gate.moodDelta < 0 ? 0.6 : 0) : undefined });
        if (res === 'V') {
          const bonus = world.sponsorships.filter((s) => s.clubId === club.id).reduce((s, x) => s + winBonus(x.perRound), 0);
          st.balance += bonus; add(st.income, 'Patrocínio', bonus);
        }
      }
    }

    // receitas e despesas de rodada + torcida
    for (const club of world.clubs) {
      const st = S.get(club.id)!;
      const p = played.get(club.id);
      const campaigns = plan.get(club.id)?.(round) ?? [];

      st.balance += sponsorPay.get(club.id)!; add(st.income, 'Patrocínio', sponsorPay.get(club.id)!);
      const mem = updateMembers({ members: st.members, fanBase: st.fanBase, fanMood: st.mood, monthlyPrice: club.membershipPrice, reputation: club.reputation });
      st.members = mem.members; st.balance += mem.revenuePerRound; add(st.income, 'Sócio-torcedor', mem.revenuePerRound);
      const merch = merchandisingPerRound(st.fanBase, club.reputation, st.mood);
      st.balance += merch; add(st.income, 'Produtos', merch);
      st.balance -= wages.get(club.id)!; add(st.expense, 'Salários', wages.get(club.id)!);
      const maint = Object.values(club.facilities).reduce((s, lvl) => s + maintenancePerRound(lvl), 0);
      st.balance -= maint; add(st.expense, 'Manutenção', maint);
      for (const c of campaigns) {
        const cost = CAMPAIGNS[c].costPerRound(st.fanBase);
        st.balance -= cost; add(st.expense, 'Marketing', cost);
        st.mood = Math.min(100, st.mood + CAMPAIGNS[c].moodBonus);
      }

      const squad = world.players.filter((x) => x.clubId === club.id && !x.isYouth);
      const fans = updateFans({
        fanBase: st.fanBase, fanMood: st.mood,
        market: { cityPopulation: cityOf(club).population, clubsInCity: clubsInCity(club), reputation: club.reputation },
        result: p?.res, isDerby: p?.derby, winStreak: st.streak, homeOccupancy: p?.occ, ticketPriceScore: p?.price,
        activeCampaigns: campaigns, idolsPopularity: squad.map((x) => x.popularity), homegrownStarters: 0, difficulty: diff,
      });
      st.fanBase = fans.newFanBase;
      for (const b of fans.breakdown) st.reasons.set(b.reason, (st.reasons.get(b.reason) ?? 0) + b.fans);
      st.streak = p?.res === 'V' ? st.streak + 1 : p ? 0 : st.streak;
    }
  }

  // fim de temporada: título, acesso, rebaixamento
  const table = (tier: number) => world.clubs.filter((c) => c.tier === tier)
    .sort((a, b) => { const x = S.get(a.id)!, y = S.get(b.id)!; return y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf; });
  const { promotion, relegation, divisions } = world.settings.structure;
  for (let t = 1; t <= divisions; t++) {
    const tb = table(t);
    tb.forEach((club, pos) => {
      const ev: SeasonEvent[] = [];
      if (pos === 0 && t === 1) ev.push('TITULO_LIGA');
      if (t > 1 && pos < promotion) ev.push('ACESSO');
      if (t < divisions && pos >= tb.length - relegation) ev.push('REBAIXAMENTO');
      if (!ev.length) return;
      const st = S.get(club.id)!;
      const r = updateFans({ fanBase: st.fanBase, fanMood: st.mood,
        market: { cityPopulation: cityOf(club).population, clubsInCity: clubsInCity(club), reputation: club.reputation },
        winStreak: 0, activeCampaigns: [], idolsPopularity: [], homegrownStarters: 0, seasonEvents: ev, difficulty: diff });
      st.fanBase = r.newFanBase;
      for (const b of r.breakdown) st.reasons.set(b.reason, (st.reasons.get(b.reason) ?? 0) + b.fans);
    });
  }
  return { S, table };
}

// ================================================================ main
const settings: RoomSettings = structuredClone(DEFAULT_SETTINGS);
settings.name = 'Liga dos Amigos';
const world = generateWorld(settings, 2026);
const diff = DIFFICULTY[settings.difficulty];

const base = runSeason(world, new Map());
// clube de teste: um time da Série B com finanças saudáveis (5º maior lucro sem marketing)
const test = world.clubs.filter((c) => c.tier === 2)
  .sort((a, b) => (base.S.get(b.id)!.balance - b.balance) - (base.S.get(a.id)!.balance - a.balance))[4];
const plan = new Map<number, (r: number) => CampaignKind[]>([[test.id, (r) => {
  const out: CampaignKind[] = ['PROJETO_SOCIAL'];        // a temporada toda
  if (r <= 10) out.push('ESCOLAS');                     // primeiras 10 rodadas
  if (r % 8 >= 1 && r % 8 <= 4) out.push('REDES_SOCIAIS'); // 4 rodadas a cada 8
  if (r >= 19 && r <= 21) out.push('TV_RADIO');         // virada de turno
  if (r === 20) out.push('EXCURSAO');
  if (r >= 30 && r <= 34) out.push('INGRESSO_SOLIDARIO');
  return out;
}]]);

const invest = runSeason(world, plan);

console.log(`\n=== Série A — classificação final (${settings.name}) ===`);
base.table(1).slice(0, 6).forEach((c, i) => {
  const s = base.S.get(c.id)!;
  console.log(`${String(i + 1).padStart(2)}. ${c.shortName} ${c.name.padEnd(36)} ${String(s.pts).padStart(2)} pts  ${s.w}V ${s.d}E ${s.l}D  saldo ${s.gf - s.ga >= 0 ? '+' : ''}${s.gf - s.ga}`);
});

console.log('\n=== Torcida: quem mais cresceu (sem marketing) ===');
[...world.clubs].map((c) => ({ c, s: base.S.get(c.id)! }))
  .sort((a, b) => (b.s.fanBase / b.c.fanBase) - (a.s.fanBase / a.c.fanBase)).slice(0, 5)
  .forEach(({ c, s }) => console.log(`${c.shortName.padEnd(4)} Série ${c.tier === 1 ? 'A' : 'B'}  ${fmt(c.fanBase).padStart(10)} -> ${fmt(s.fanBase).padStart(10)}  (${((s.fanBase / c.fanBase - 1) * 100).toFixed(1)}%)  ${s.w}V ${s.d}E ${s.l}D`));

const b = base.S.get(test.id)!, v = invest.S.get(test.id)!;
console.log(`\n=== Experimento: ${test.name} (Série B) com e sem ações de marketing ===`);
console.log(`Torcida inicial:      ${fmt(test.fanBase)}`);
console.log(`Sem marketing:        ${fmt(b.fanBase)} (${((b.fanBase / test.fanBase - 1) * 100).toFixed(1)}%) | campanha ${b.w}V ${b.d}E ${b.l}D`);
console.log(`Com marketing:        ${fmt(v.fanBase)} (${((v.fanBase / test.fanBase - 1) * 100).toFixed(1)}%) | campanha ${v.w}V ${v.d}E ${v.l}D`);
console.log(`Sócios no fim:        ${fmt(b.members)} -> ${fmt(v.members)}`);
console.log(`Gasto com marketing:  ${brl(v.expense['Marketing'] ?? 0)}`);
const sp = (fans: number) => sponsorValuePerRound({ slot: 'MASTER', fanBase: fans, reputation: test.reputation, divisionTier: test.tier, difficulty: diff });
console.log(`Patrocínio master justo por rodada: ${brl(sp(b.fanBase))} (sem) vs ${brl(sp(v.fanBase))} (com) → +${brl((sp(v.fanBase) - sp(b.fanBase)) * 38)} por temporada no próximo contrato`);
console.log('De onde vieram os torcedores (com marketing):');
[...v.reasons.entries()].sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 10)
  .forEach(([r, n]) => console.log(`   ${(n >= 0 ? '+' : '') + fmt(n)}`.padEnd(14) + r));
console.log('Finanças da temporada (com marketing):');
for (const [k, val] of Object.entries(v.income)) console.log(`   + ${brl(val).padEnd(16)} ${k}`);
for (const [k, val] of Object.entries(v.expense)) console.log(`   - ${brl(val).padEnd(16)} ${k}`);
console.log(`   Caixa: ${brl(test.balance)} -> ${brl(v.balance)} (sem marketing: ${brl(b.balance)})`);

// ----------------------------------------------------------- regras da sala
console.log('\n=== Configuração da sala ===');
const bad: RoomSettings = structuredClone(DEFAULT_SETTINGS);
bad.structure.clubsPerDivision = 15; bad.pacing.minPrepSeconds = 900; bad.structure.relegation = 3;
console.log('Erros de uma configuração inválida:\n  - ' + validateSettings(bad).join('\n  - '));

// Sessão com 4 humanos, tempo limite de 10 min, espera mínima de 20 s, AFK após 2 prazos perdidos
const live: RoomSettings = structuredClone(settings);
live.pacing = { prepTimeoutMinutes: 10, minPrepSeconds: 20, afkAfterMisses: 2 };
const t0 = new Date('2026-11-08T20:00:00-03:00');
const at = (sec: number) => new Date(t0.getTime() + sec * 1000);
const slots = (ready: string[], afk: string[] = []): HumanSlot[] =>
  ['ana', 'bia', 'caio', 'davi'].map((u) => ({ userId: u, ready: ready.includes(u), afk: afk.includes(u) }));
const show = (label: string, sec: number, h: HumanSlot[]) => {
  const d = decideRound({ now: at(sec), prepStartedAt: t0, humans: h, settings: live });
  const txt = d.run ? `RODA (${d.reason}${d.missed.length ? '; não confirmaram: ' + d.missed.join(', ') : ''})`
    : `espera ${d.waitingFor.join(', ') || '(espera mínima)'}`;
  console.log(`  ${label.padEnd(44)} → ${txt}`);
};
console.log('\n"Todos prontos" com tempo limite de 10 min:');
show('10 s depois, os 4 prontos', 10, slots(['ana', 'bia', 'caio', 'davi']));
show('30 s depois, os 4 prontos', 30, slots(['ana', 'bia', 'caio', 'davi']));
show('5 min depois, 3 prontos', 300, slots(['ana', 'bia', 'caio']));
show('10 min depois, 3 prontos', 600, slots(['ana', 'bia', 'caio']));
const misses = new Map<string, number>();
updateAfk(misses, slots(['ana', 'bia', 'caio']), ['davi'], live);
const r2 = updateAfk(misses, slots(['ana', 'bia', 'caio']), ['davi'], live);
console.log(`  davi perdeu 2 prazos seguidos → AFK: ${r2.nowAfk.join(', ')}`);
show('rodada seguinte, 3 prontos, davi AFK', 30, slots(['ana', 'bia', 'caio'], ['davi']));
show('davi volta e clica Pronto (bia ainda não)', 30, slots(['ana', 'caio', 'davi'], ['davi']));

// Modo solo: 1 humano contra a IA. Mesmo que o dono tenha deixado tempo limite, a sala espera.
const solo = normalizeSettings({ ...structuredClone(settings), maxHumans: 1, pacing: { prepTimeoutMinutes: 10, minPrepSeconds: 5, afkAfterMisses: 3 } });
console.log(`\nModo solo (erros de validação: ${validateSettings(solo).length}) → tempo limite: ${solo.pacing.prepTimeoutMinutes ?? 'nenhum'}`);
const eu = (ready: boolean): HumanSlot[] => [{ userId: 'raul', ready, afk: false }];
for (const [label, sec, ready] of [['3 horas depois, sem clicar Pronto', 3 * 3600, false], ['clicou Pronto', 10, true]] as const) {
  const d = decideRound({ now: at(sec), prepStartedAt: t0, humans: eu(ready), settings: solo });
  console.log(`  ${label.padEnd(44)} → ${d.run ? 'RODA (' + d.reason + ')' : 'espera você'}`);
}

console.log('\nVelocidade da partida (duração da exibição "ao vivo" de 90 min):');
for (const sp of Object.keys(MS_PER_MATCH_MINUTE) as (keyof typeof MS_PER_MATCH_MINUTE)[])
  console.log(`  ${sp.padEnd(12)} ${liveDurationMs(sp) === 0 ? 'resultado direto' : (liveDurationMs(sp) / 1000).toFixed(0) + ' s'}`);

console.log('\nResultado financeiro da temporada por divisão (sem marketing):');
for (const d of world.divisions) {
  const deltas = world.clubs.filter((c) => c.tier === d.tier).map((c) => base.S.get(c.id)!.balance - c.balance).sort((a, b) => a - b);
  const med = deltas[Math.floor(deltas.length / 2)];
  const tot = (f: (s: ClubState) => number) => { const xs = world.clubs.filter((c) => c.tier === d.tier).map((c) => f(base.S.get(c.id)!)).sort((x, y) => x - y); return xs[Math.floor(xs.length / 2)]; };
  console.log(`  ${d.name}: receita mediana ${brl(tot((s) => Object.values(s.income).reduce((x, y) => x + y, 0)))} | salários medianos ${brl(tot((s) => s.expense['Salários'] ?? 0))}`);
  console.log(`  ${d.name}: pior ${brl(deltas[0])} | mediana ${brl(med)} | melhor ${brl(deltas[deltas.length - 1])} | ${deltas.filter((x) => x < 0).length} clubes no prejuízo`);
}
