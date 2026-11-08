// Gerador de mundo fictício: cidades, clubes, elencos, staff, patrocinadores,
// estádios e tabela de jogos. Determinístico pela semente.
// Aceita um "patch" (CustomWorld) com clubes/jogadores editados pela comunidade;
// o que não vier no patch é gerado.

import { referencePrice, marketValue } from './economy.ts';
import {
  marketPotential, membershipReferencePrice, sponsorValuePerRound, winBonus, sponsorBreakFee,
  type SponsorSlot,
} from './fans.ts';
import {
  CITIES, CLUB_PATTERNS, FIRST_NAMES, KIT_BRANDS, LAST_NAMES, MASCOTS, NAME_WORDS, NICKNAMES,
  cityPrep, isRealClubName, SPONSOR_NAME, SPONSOR_PREFIX, STADIUM_PATTERNS, normalize, type CityDef,
} from './names.ts';
import { Rng } from './rng.ts';
import { DIFFICULTY, type RoomSettings } from './settings.ts';
import { overall } from './strength.ts';
import { ATTRIBUTES, type Attribute, type Player, type Position } from './types.ts';
import { generateYouthIntake } from './youth.ts';
import type { Sector } from './economy.ts';

// ============================================================== tipos
export interface GenCity extends CityDef { id: number }
export interface GenClub {
  id: number;
  tier: number;                 // divisão 1..4
  name: string;
  shortName: string;
  cityId: number;
  reputation: number;
  fanBase: number;
  fanMood: number;
  balance: number;              // centavos
  rivalId: number | null;
  stadiumName: string;
  membershipPrice: number;      // centavos/mês
  facilities: { ESTADIO: number; CT: number; BASE: number; DEPTO_MEDICO: number };
  sectors: { sector: Sector; capacity: number; ticketPrice: number; comfort: number }[];
  level: number;                // nível médio do elenco (interno)
}
export interface GenPlayer extends Player {
  clubId: number | null;
  isYouth: boolean;
  weeklySalary: number;
  contractEnd: number;
  marketValue: number;
}
export type StaffRole = 'TECNICO' | 'AUXILIAR' | 'PREP_FISICO' | 'TREINADOR_GOLEIROS'
  | 'MEDICO' | 'FISIOTERAPEUTA' | 'OLHEIRO' | 'TREINADOR_BASE';
export const STAFF_ROLES: StaffRole[] = ['TECNICO', 'AUXILIAR', 'PREP_FISICO', 'TREINADOR_GOLEIROS',
  'MEDICO', 'FISIOTERAPEUTA', 'OLHEIRO', 'TREINADOR_BASE'];
export interface GenStaff {
  id: number; name: string; role: StaffRole; skill: number; tactics: number; motivation: number;
  youthDev: number; reputation: number; clubId: number | null; weeklySalary: number; contractEnd: number;
}
export interface GenSponsor { id: number; name: string; slot: SponsorSlot; minReputation: number }
export interface GenSponsorship {
  sponsorId: number; clubId: number; slot: SponsorSlot; perRound: number; bonusPerWin: number;
  endSeason: number; breakFee: number;
}
export interface GenFixture { tier: number; round: number; homeId: number; awayId: number }

export interface WorldData {
  settings: RoomSettings;
  seed: number;
  cities: GenCity[];
  divisions: { tier: number; name: string }[];
  clubs: GenClub[];
  players: GenPlayer[];
  staff: GenStaff[];
  sponsors: GenSponsor[];
  sponsorships: GenSponsorship[];
  fixtures: GenFixture[];
  warnings: string[];
}

// Patch editável pela comunidade (ver importexport.ts)
export interface CustomClub {
  name: string; shortName: string; city: string; state?: string; population?: number;
  division: number; reputation?: number; fanBase?: number; stadiumName?: string; stadiumCapacity?: number;
}
export interface CustomPlayer {
  name: string; club: string | null; position: Position; age: number;
  attrs: Record<Attribute, number>; potential?: number;
}
export interface CustomWorld { clubs?: CustomClub[]; players?: CustomPlayer[] }

// ======================================================= parâmetros
const TIER_NAMES = ['Série A', 'Série B', 'Série C', 'Série D'];
const TIER_LEVEL = [70, 63, 57, 52];           // nível médio do elenco
const TIER_REP = [70, 55, 42, 32];             // reputação média
const TIER_CAPACITY = [45_000, 25_000, 12_000, 6_000];
const TIER_BALANCE_BRL = [30_000_000, 12_000_000, 5_000_000, 2_000_000];
const TIER_FACILITY = [6, 4, 3, 2];
const SQUAD: [Position, number][] = [['GOL', 3], ['ZAG', 4], ['LAT', 4], ['VOL', 4], ['MEI', 5], ['ATA', 5]];
const FAVORED: Record<Position, Attribute[]> = {
  GOL: ['goalkeeping'], ZAG: ['defending', 'heading', 'strength'], LAT: ['pace', 'defending', 'stamina'],
  VOL: ['defending', 'passing', 'stamina'], MEI: ['passing', 'vision', 'dribbling'], ATA: ['finishing', 'pace', 'dribbling'],
};
const SECTOR_SPLIT: [Sector, number, number][] = [ // setor, % da capacidade, conforto
  ['GERAL', 0.45, 30], ['ARQUIBANCADA', 0.35, 50], ['CADEIRA', 0.17, 70], ['CAMAROTE', 0.03, 92],
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Salário semanal (centavos) a partir do overall. */
export function salaryFor(ovr: number, wageDemands = 1): number {
  // Curva calibrada para a folha ficar ~75% da receita em todas as divisões
  // (estrelas custam muito mais: cada +4 de overall dobra o salário).
  // ovr 55 ≈ R$ 6 mil/semana, ovr 65 ≈ R$ 26 mil, ovr 75 ≈ R$ 113 mil, ovr 80 ≈ R$ 236 mil
  return Math.round(Math.exp((ovr - 40) / 5.75) * 345 * wageDemands) * 100;
}

// ========================================================== gerador
export function generateWorld(settings: RoomSettings, seed: number, custom: CustomWorld = {}): WorldData {
  const rng = new Rng(seed);
  const warnings: string[] = [];
  const { divisions: D, clubsPerDivision: N } = settings.structure;
  const total = D * N;
  const ids = { city: 0, club: 0, player: 0, staff: 0, sponsor: 0 };
  const diff = DIFFICULTY[settings.difficulty];

  // ---------------------------------------------------------- cidades
  const cities: GenCity[] = [];
  const cityByName = new Map<string, GenCity>();
  const getCity = (name: string, state?: string, population?: number): GenCity => {
    const key = normalize(name);
    let c = cityByName.get(key);
    if (!c) {
      const known = CITIES.find((x) => normalize(x.name) === key);
      c = { id: ++ids.city, name, state: state ?? known?.state ?? '??', population: population ?? known?.population ?? 200_000 };
      cities.push(c);
      cityByName.set(key, c);
    }
    return c;
  };

  // --------------------------------------------- clubes (patch + gerados)
  const clubs: GenClub[] = [];
  const usedNames = new Set<string>();
  const usedShort = new Set<string>();

  const customClubs = (custom.clubs ?? []).slice(0, total);
  if ((custom.clubs?.length ?? 0) > total) warnings.push(`Patch tem ${custom.clubs!.length} clubes; usando os ${total} primeiros.`);
  const perTierCustom = new Map<number, number>();
  for (const cc of customClubs) {
    let tier = clamp(Math.round(cc.division), 1, D);
    // se a divisão estiver cheia, empurra para a próxima com vaga
    while ((perTierCustom.get(tier) ?? 0) >= N && tier < D) tier++;
    if ((perTierCustom.get(tier) ?? 0) >= N) { warnings.push(`Sem vaga para "${cc.name}".`); continue; }
    perTierCustom.set(tier, (perTierCustom.get(tier) ?? 0) + 1);
    const city = getCity(cc.city, cc.state, cc.population);
    usedNames.add(normalize(cc.name));
    const sn = cc.shortName.toUpperCase().slice(0, 4);
    if (usedShort.has(sn)) warnings.push(`Sigla repetida: ${sn}.`);
    usedShort.add(sn);
    clubs.push(baseClub(tier, cc.name, sn, city, cc.reputation, cc.fanBase, cc.stadiumName, cc.stadiumCapacity));
  }

  // cidades sorteadas por população; cidades grandes recebem até 3 clubes
  const cityCount = new Map<string, number>();
  for (const c of clubs) {
    const k = normalize(cities.find((x) => x.id === c.cityId)!.name);
    cityCount.set(k, (cityCount.get(k) ?? 0) + 1);
  }
  const cap = (p: number) => (p >= 5_000_000 ? 3 : p >= 1_200_000 ? 2 : 1);

  const generatedSlots: number[] = [];
  for (let t = 1; t <= D; t++) for (let i = perTierCustom.get(t) ?? 0; i < N; i++) generatedSlots.push(t);

  // sorteia cidades primeiro e ordena por "força de mercado" para distribuir nas divisões
  const picked: CityDef[] = [];
  for (let guard = 0; picked.length < generatedSlots.length && guard < 10_000; guard++) {
    const c = rng.weighted(CITIES, (x) => Math.sqrt(x.population));
    const k = normalize(c.name);
    if ((cityCount.get(k) ?? 0) >= cap(c.population)) continue;
    cityCount.set(k, (cityCount.get(k) ?? 0) + 1);
    picked.push(c);
  }
  if (picked.length < generatedSlots.length) throw new Error('Cidades insuficientes para gerar o mundo.');
  const ranked = picked
    .map((c) => ({ c, score: Math.log(c.population) + rng.gauss() * 0.8 }))
    .sort((a, b) => b.score - a.score);

  for (let i = 0; i < generatedSlots.length; i++) {
    const tier = generatedSlots[i]; // já em ordem crescente: as cidades mais fortes vão para a Série A
    const cityDef = ranked[i].c;
    const city = getCity(cityDef.name, cityDef.state, cityDef.population);
    const name = makeClubName(city.name);
    const sn = makeShort(name, city.name);
    clubs.push(baseClub(tier, name, sn, city));
  }

  // rivais: mesma cidade; senão mesmo estado e mesma divisão
  for (const c of clubs) {
    const sameCity = clubs.filter((o) => o !== c && o.cityId === c.cityId);
    const state = cities.find((x) => x.id === c.cityId)!.state;
    const sameState = clubs.filter((o) => o !== c && cities.find((x) => x.id === o.cityId)!.state === state);
    const pool = sameCity.length ? sameCity : sameState.filter((o) => Math.abs(o.tier - c.tier) <= 1);
    // o rival mais "parecido": mesma divisão primeiro, depois reputação mais próxima
    const score = (o: GenClub) => Math.abs(o.tier - c.tier) * 100 + Math.abs(o.reputation - c.reputation);
    c.rivalId = pool.length ? pool.sort((a, b) => score(a) - score(b))[0].id : null;
  }

  // ------------------------------------------------------- jogadores
  const players: GenPlayer[] = [];
  const customPlayers = custom.players ?? [];
  const byShort = new Map(clubs.map((c) => [c.shortName, c]));
  const customCount = new Map<number, number>();
  for (const cp of customPlayers) {
    const club = cp.club ? byShort.get(cp.club.toUpperCase()) : undefined;
    if (cp.club && !club) { warnings.push(`Jogador "${cp.name}": clube ${cp.club} não existe; ficou sem clube.`); }
    const p: Player = {
      id: ++ids.player, name: cp.name, age: cp.age, position: cp.position, attrs: { ...cp.attrs },
      potential: cp.potential ?? 0, form: 50, fitness: 100, morale: 60, popularity: 10,
    };
    p.potential = Math.max(overall(p), cp.potential ?? overall(p) + Math.max(0, 24 - cp.age) * 1.5);
    players.push(finishPlayer(p, club?.id ?? null, false));
    if (club) customCount.set(club.id, (customCount.get(club.id) ?? 0) + 1);
  }

  for (const club of clubs) {
    // clube com elenco completo vindo do patch não recebe jogadores gerados;
    // elenco incompleto é completado posição por posição
    const have = customCount.get(club.id) ?? 0;
    const squad: GenPlayer[] = [];
    for (const [pos, n] of SQUAD) {
      if (have >= settings.rules.squadMin) break;
      const existing = players.filter((p) => p.clubId === club.id && p.position === pos && !p.isYouth).length;
      for (let i = existing; i < n; i++) {
        const starter = i < Math.ceil(n / 2);
        const lvl = club.level + rng.gauss() * 3.5 - (starter ? 0 : 4);
        squad.push(finishPlayer(makePlayer(pos, lvl), club.id, false));
      }
    }
    // ídolos: os 1-2 melhores ganham popularidade
    squad.sort((a, b) => overall(b) - overall(a));
    squad.slice(0, rng.int(1, 2)).forEach((p) => { p.popularity = rng.int(55, 85); });
    players.push(...squad);

    // base
    const youth = generateYouthIntake(club.facilities.BASE, 50, rng, () => ++ids.player);
    for (const y of youth) players.push(finishPlayer(y, club.id, true));
  }
  // agentes livres
  for (let i = 0; i < Math.round(total * 2); i++) {
    const pos = rng.weighted(SQUAD, ([, n]) => n)[0];
    players.push(finishPlayer(makePlayer(pos, 50 + rng.gauss() * 7), null, false));
  }

  // ---------------------------------------------------------- staff
  const staff: GenStaff[] = [];
  for (const club of clubs) {
    for (const role of STAFF_ROLES) staff.push(makeStaff(role, club.level + rng.gauss() * 5, club.id));
  }
  for (const role of STAFF_ROLES) for (let i = 0; i < D * 4; i++) staff.push(makeStaff(role, 45 + rng.gauss() * 12, null));

  // ---------------------------------------------- patrocinadores
  const sponsors: GenSponsor[] = [];
  const sponsorNames = new Set<string>();
  const slots: SponsorSlot[] = ['MASTER', 'COSTAS', 'MANGA', 'ESTADIO'];
  for (let i = 0; i < Math.max(30, total); i++) {
    let name = '';
    for (let g = 0; g < 50 && (!name || sponsorNames.has(name)); g++)
      name = `${SPONSOR_PREFIX[rng.int(0, SPONSOR_PREFIX.length - 1)]} ${SPONSOR_NAME[rng.int(0, SPONSOR_NAME.length - 1)]}`;
    if (sponsorNames.has(name)) continue;
    sponsorNames.add(name);
    sponsors.push({ id: ++ids.sponsor, name, slot: slots[i % slots.length], minReputation: clamp(Math.round(20 + rng.next() * 60), 1, 100) });
  }
  for (const b of KIT_BRANDS) sponsors.push({ id: ++ids.sponsor, name: b, slot: 'MATERIAL', minReputation: rng.int(10, 60) });

  // todo clube começa com patrocínio master e de material esportivo
  const sponsorships: GenSponsorship[] = [];
  for (const club of clubs) {
    for (const slot of ['MASTER', 'MATERIAL'] as SponsorSlot[]) {
      const options = sponsors.filter((s) => s.slot === slot && s.minReputation <= club.reputation + 10);
      const sp = options.length ? options[rng.int(0, options.length - 1)] : sponsors.find((s) => s.slot === slot)!;
      const perRound = sponsorValuePerRound({ slot, fanBase: club.fanBase, reputation: club.reputation, divisionTier: club.tier, difficulty: diff });
      const endSeason = rng.int(1, 2);
      sponsorships.push({
        sponsorId: sp.id, clubId: club.id, slot, perRound, bonusPerWin: winBonus(perRound),
        endSeason, breakFee: sponsorBreakFee(perRound, (N - 1) * 2 * endSeason),
      });
    }
  }

  // ------------------------------------------------------- calendário
  const fixtures: GenFixture[] = [];
  for (let t = 1; t <= D; t++) fixtures.push(...doubleRoundRobin(clubs.filter((c) => c.tier === t).map((c) => c.id), t, rng));

  return {
    settings, seed, cities, warnings, players, staff, sponsors, sponsorships, fixtures, clubs,
    divisions: Array.from({ length: D }, (_, i) => ({ tier: i + 1, name: TIER_NAMES[i] })),
  };

  // ============================================ helpers (closures)
  function baseClub(tier: number, name: string, shortName: string, city: GenCity,
    rep?: number, fans?: number, stadiumName?: string, capacity?: number): GenClub {
    const t = tier - 1;
    const popBonus = Math.log10(city.population / 500_000) * 4;
    const reputation = clamp(Math.round(rep ?? TIER_REP[t] + popBonus + rng.gauss() * 5), 5, 95);
    const market = marketPotential({ cityPopulation: city.population, clubsInCity: 1, reputation });
    const fanBase = Math.round(fans ?? market * (0.25 + rng.next() * 0.2));
    const level = TIER_LEVEL[t] + (reputation - TIER_REP[t]) * 0.25 + rng.gauss() * 1.5;
    const cap = Math.round((capacity ?? TIER_CAPACITY[t] * (0.7 + rng.next() * 0.6)) / 500) * 500;
    const fac = TIER_FACILITY[t];
    return {
      id: ++ids.club, tier, name, shortName, cityId: city.id, reputation, fanBase,
      fanMood: rng.int(50, 70),
      balance: Math.round(TIER_BALANCE_BRL[t] * (0.7 + rng.next() * 0.6)) * 100,
      rivalId: null,
      stadiumName: stadiumName ?? makeStadium(city.name),
      membershipPrice: membershipReferencePrice(reputation),
      facilities: {
        ESTADIO: clamp(fac + rng.int(-1, 1), 1, 10), CT: clamp(fac + rng.int(-1, 1), 1, 10),
        BASE: clamp(fac + rng.int(-1, 1), 1, 10), DEPTO_MEDICO: clamp(fac + rng.int(-1, 1), 1, 10),
      },
      sectors: SECTOR_SPLIT.map(([sector, share, comfort]) => ({
        sector, capacity: Math.round(cap * share), ticketPrice: referencePrice(sector, reputation),
        comfort: clamp(comfort + (fac - 3) * 3, 1, 100),
      })),
      level,
    };
  }

  function makeClubName(city: string): string {
    for (let g = 0; g < 60; g++) {
      const pat = CLUB_PATTERNS[rng.int(0, CLUB_PATTERNS.length - 1)];
      const name = pat.replace('{DE}', cityPrep(city)).replace('{C}', city).replace('{M}', MASCOTS[rng.int(0, MASCOTS.length - 1)])
        .replace('{X}', NAME_WORDS[rng.int(0, NAME_WORDS.length - 1)]);
      const k = normalize(name);
      if (!usedNames.has(k) && !isRealClubName(name)) { usedNames.add(k); return name; }
    }
    const name = `${MASCOTS[rng.int(0, MASCOTS.length - 1)]} ${cityPrep(city)} ${city} ${ids.club}`;
    usedNames.add(normalize(name));
    return name;
  }

  // Sigla: tenta várias formas antes de cair em número (ex.: "Real São Paulo" -> SAO, SPA, RSP...)
  function makeShort(clubName: string, city: string): string {
    const words = (t: string) => normalize(t).replace(/[^a-z ]/g, ' ').split(' ').filter((w) => w.length > 2);
    const cw = words(city);
    const prefix = words(clubName.replace(city, ''));
    const cityInit = cw.map((w) => w[0]).join('');
    const candidates = [
      cw.length > 1 ? cityInit.slice(0, 3) + (cityInit.length < 3 ? cw[cw.length - 1][1] : '') : cw[0].slice(0, 3),
      cw.join('').slice(0, 3),
      prefix.length ? prefix[0][0] + (cw.length > 1 ? cityInit.slice(0, 2) : cw[0].slice(0, 2)) : '',
      prefix.length ? cw[0].slice(0, 2) + prefix[0][0] : '',
      prefix.length > 1 ? prefix[0][0] + prefix[1][0] + cw[0][0] : '',
    ].map((x) => x.toUpperCase()).filter((x) => x.length === 3);
    let sn = candidates.find((c) => !usedShort.has(c));
    for (let i = 2; !sn; i++) if (!usedShort.has(candidates[0] + i)) sn = candidates[0] + i;
    usedShort.add(sn);
    return sn;
  }

  function makeStadium(city: string): string {
    const pat = STADIUM_PATTERNS[rng.int(0, STADIUM_PATTERNS.length - 1)];
    return pat.replace('{C}', city).replace('{M}', MASCOTS[rng.int(0, MASCOTS.length - 1)])
      .replace('{S}', LAST_NAMES[rng.int(0, LAST_NAMES.length - 1)]);
  }

  function personName(): string {
    const first = FIRST_NAMES[rng.int(0, FIRST_NAMES.length - 1)];
    const last = LAST_NAMES[rng.int(0, LAST_NAMES.length - 1)];
    if (rng.chance(0.25)) return NICKNAMES[rng.int(0, NICKNAMES.length - 1)].replace('{L}', last);
    return `${first} ${last}`;
  }

  function makePlayer(pos: Position, level: number): Player {
    const age = clamp(Math.round(26 + rng.gauss() * 4.5), 17, 37);
    // jovens um pouco abaixo do nível do clube, veteranos perdem físico
    const ageAdj = age < 21 ? -(21 - age) * 1.5 : 0;
    const attrs = {} as Record<Attribute, number>;
    for (const a of ATTRIBUTES) {
      let v = level - 12 + ageAdj + rng.gauss() * 5;
      if (FAVORED[pos].includes(a)) v += 14;
      if (age > 31 && (a === 'pace' || a === 'stamina')) v -= (age - 31) * 2;
      if (a === 'goalkeeping' && pos !== 'GOL') v = 5 + rng.int(0, 10);
      attrs[a] = clamp(Math.round(v), 1, 99);
    }
    const p: Player = { id: ++ids.player, name: personName(), age, position: pos, attrs, potential: 0,
      form: rng.int(40, 60), fitness: 100, morale: rng.int(50, 70), popularity: rng.int(0, 25) };
    const ovr = overall(p);
    p.potential = clamp(Math.round(ovr + Math.max(0, 25 - age) * 1.6 + Math.abs(rng.gauss()) * 4), ovr, 99);
    return p;
  }

  function finishPlayer(p: Player, clubId: number | null, isYouth: boolean): GenPlayer {
    const ovr = overall(p);
    return {
      ...p, clubId, isYouth,
      weeklySalary: isYouth ? 50_000 + ovr * 2_000 : salaryFor(ovr),
      contractEnd: 1 + rng.int(0, 3),
      marketValue: marketValue(ovr, p.age, p.potential),
    };
  }

  function makeStaff(role: StaffRole, level: number, clubId: number | null): GenStaff {
    const skill = clamp(Math.round(level), 10, 95);
    return {
      id: ++ids.staff, name: personName(), role, skill,
      tactics: clamp(Math.round(skill + rng.gauss() * 8), 1, 100),
      motivation: clamp(Math.round(skill + rng.gauss() * 8), 1, 100),
      youthDev: clamp(Math.round(skill + rng.gauss() * 8), 1, 100),
      reputation: clamp(Math.round(skill - 15 + rng.gauss() * 10), 1, 100),
      clubId, weeklySalary: Math.round(salaryFor(skill) * (role === 'TECNICO' ? 1.2 : 0.35)),
      contractEnd: 1 + rng.int(0, 2),
    };
  }
}

// =============================================== tabela (todos x todos)
/** Método do círculo: turno e returno, mandos alternados. */
export function doubleRoundRobin(clubIds: number[], tier: number, rng: Rng): GenFixture[] {
  const ids = [...clubIds];
  for (let i = ids.length - 1; i > 0; i--) { const j = rng.int(0, i); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const n = ids.length;
  const rounds = n - 1;
  const out: GenFixture[] = [];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = ids[i], b = ids[n - 1 - i];
      const flip = (i === 0 ? r % 2 === 1 : i % 2 === 1);
      const [home, away] = flip ? [b, a] : [a, b];
      out.push({ tier, round: r + 1, homeId: home, awayId: away });
      out.push({ tier, round: r + 1 + rounds, homeId: away, awayId: home });
    }
    ids.splice(1, 0, ids.pop()!); // gira mantendo o primeiro fixo
  }
  return out.sort((x, y) => x.round - y.round);
}

// ============================================= entrada de humanos
/** Clubes disponíveis para um novo jogador humano, conforme a regra da sala. */
export function availableClubs(world: WorldData, takenClubIds: Set<number>): GenClub[] {
  const free = world.clubs.filter((c) => !takenClubIds.has(c.id));
  const { humanStart, divisions } = world.settings.structure;
  if (humanStart === 'ULTIMA_DIVISAO') return free.filter((c) => c.tier === divisions);
  return free;
}

/** Ajusta o clube quando um humano assume (dificuldade muda o caixa inicial). */
export function claimClub(club: GenClub, settings: RoomSettings): GenClub {
  return { ...club, balance: Math.round(club.balance * DIFFICULTY[settings.difficulty].startingBalance) };
}
