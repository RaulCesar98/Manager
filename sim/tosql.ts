// Converte um WorldData em script SQL que cria a sala inteira num banco
// que já pode ter outras salas. Os ids gerados são locais (1, 2, 3...) e
// recebem um deslocamento calculado na hora, dentro de uma transação.

import { maintenancePerRound } from './economy.ts';
import type { WorldData } from './worldgen.ts';

const q = (v: string | number | boolean | null | undefined): string => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('número inválido'); return String(Math.round(v)); }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return `'${v.replace(/'/g, "''")}'`;
};

/** INSERT ... SELECT a partir de VALUES, com expressões que usam o deslocamento `o`. */
function bulk(table: string, cols: string[], exprs: string[], alias: string[], rows: unknown[][]): string {
  if (!rows.length) return '';
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const values = rows.slice(i, i + 500).map((r) => `(${r.map((x) => q(x as never)).join(',')})`).join(',\n  ');
    out.push(`INSERT INTO ${table} (${cols.join(', ')})\nSELECT ${exprs.join(', ')}\nFROM _o o, (VALUES\n  ${values}\n) v(${alias.join(', ')});`);
  }
  return out.join('\n');
}

export function worldToSql(w: WorldData, opts: { ownerUserId?: string } = {}): string {
  const s: string[] = [];
  const tables = ['worlds', 'cities', 'divisions', 'clubs', 'players', 'staff', 'sponsors'];
  s.push('-- Gerado por sim/tosql.ts', 'BEGIN;');
  s.push(`LOCK TABLE ${tables.join(', ')} IN EXCLUSIVE MODE;`);
  s.push(`INSERT INTO worlds (name, owner_user_id, settings, rng_seed, join_code, status)
VALUES (${q(w.settings.name)}, ${opts.ownerUserId ? `${q(opts.ownerUserId)}::uuid` : 'NULL'}, ${q(JSON.stringify(w.settings))}::jsonb, ${q(w.seed)},
        upper(substr(md5(random()::text), 1, 6)), 'LOBBY');`);
  s.push(`CREATE TEMP TABLE _o ON COMMIT DROP AS SELECT
  currval('worlds_id_seq')::int AS w,
  (SELECT coalesce(max(id),0) FROM cities)    AS city,
  (SELECT coalesce(max(id),0) FROM divisions) AS div,
  (SELECT coalesce(max(id),0) FROM clubs)     AS club,
  (SELECT coalesce(max(id),0) FROM players)   AS player,
  (SELECT coalesce(max(id),0) FROM staff)     AS staff,
  (SELECT coalesce(max(id),0) FROM sponsors)  AS sponsor;`);

  const { promotion, relegation } = w.settings.structure;
  s.push(bulk('cities', ['id', 'world_id', 'name', 'state', 'population'],
    ['v.id + o.city', 'o.w', 'v.name', 'v.state', 'v.pop'], ['id', 'name', 'state', 'pop'],
    w.cities.map((c) => [c.id, c.name, c.state, c.population])));

  s.push(bulk('divisions', ['id', 'world_id', 'name', 'tier', 'promote_n', 'relegate_n'],
    ['v.tier + o.div', 'o.w', 'v.name', 'v.tier', 'v.p', 'v.r'], ['tier', 'name', 'p', 'r'],
    w.divisions.map((d) => [d.tier, d.name, promotion, relegation])));

  s.push(bulk('clubs',
    ['id', 'world_id', 'division_id', 'name', 'short_name', 'city_id', 'rival_club_id', 'stadium_name', 'balance',
      'reputation', 'fan_base', 'fan_mood', 'membership_price'],
    ['v.id + o.club', 'o.w', 'v.tier + o.div', 'v.name', 'v.sn', 'v.city + o.city', 'v.rival + o.club', 'v.stadium',
      'v.bal', 'v.rep', 'v.fans', 'v.mood', 'v.mp'],
    ['id', 'tier', 'name', 'sn', 'city', 'rival', 'stadium', 'bal', 'rep', 'fans', 'mood', 'mp'],
    w.clubs.map((c) => [c.id, c.tier, c.name, c.shortName, c.cityId, c.rivalId, c.stadiumName, c.balance,
      c.reputation, c.fanBase, c.fanMood, c.membershipPrice])));

  s.push(bulk('facilities', ['club_id', 'type', 'level', 'maintenance_per_round'],
    ['v.club + o.club', 'v.t::facility_t', 'v.lvl', 'v.m'], ['club', 't', 'lvl', 'm'],
    w.clubs.flatMap((c) => Object.entries(c.facilities).map(([t, lvl]) => [c.id, t, lvl, maintenancePerRound(lvl)]))));

  s.push(bulk('stadium_sectors', ['club_id', 'sector', 'capacity', 'ticket_price', 'comfort'],
    ['v.club + o.club', 'v.sec::sector_t', 'v.cap', 'v.price', 'v.comfort'], ['club', 'sec', 'cap', 'price', 'comfort'],
    w.clubs.flatMap((c) => c.sectors.map((x) => [c.id, x.sector, x.capacity, x.ticketPrice, x.comfort]))));

  const A = w.players[0] ? Object.keys(w.players[0].attrs) : [];
  s.push(bulk('players',
    ['id', 'world_id', 'club_id', 'name', 'birth_season', 'position', ...A, 'potential', 'form', 'fitness', 'morale',
      'popularity', 'is_youth', 'market_value'],
    ['v.id + o.player', 'o.w', 'v.club + o.club', 'v.name', 'v.birth', 'v.pos::position_t', ...A.map((a) => `v.${a}`),
      'v.pot', 'v.form', 'v.fit', 'v.mor', 'v.pop', 'v.youth', 'v.mv'],
    ['id', 'club', 'name', 'birth', 'pos', ...A, 'pot', 'form', 'fit', 'mor', 'pop', 'youth', 'mv'],
    // idade = temporada - birth_season + 16  =>  birth_season = 1 + 16 - idade
    w.players.map((p) => [p.id, p.clubId, p.name, 17 - p.age, p.position, ...A.map((a) => p.attrs[a as keyof typeof p.attrs]),
      p.potential, p.form, p.fitness, p.morale, p.popularity, p.isYouth, p.marketValue])));

  s.push(bulk('player_contracts', ['player_id', 'club_id', 'weekly_salary', 'start_season', 'end_season'],
    ['v.p + o.player', 'v.c + o.club', 'v.sal', '1', 'v.e'], ['p', 'c', 'sal', 'e'],
    w.players.filter((p) => p.clubId).map((p) => [p.id, p.clubId, p.weeklySalary, p.contractEnd])));

  s.push(bulk('staff', ['id', 'world_id', 'name', 'role', 'skill', 'tactics', 'motivation', 'youth_dev', 'reputation'],
    ['v.id + o.staff', 'o.w', 'v.name', 'v.role::staff_role_t', 'v.sk', 'v.ta', 'v.mo', 'v.yd', 'v.rep'],
    ['id', 'name', 'role', 'sk', 'ta', 'mo', 'yd', 'rep'],
    w.staff.map((x) => [x.id, x.name, x.role, x.skill, x.tactics, x.motivation, x.youthDev, x.reputation])));

  s.push(bulk('staff_contracts', ['staff_id', 'club_id', 'weekly_salary', 'start_season', 'end_season', 'termination_fee'],
    ['v.s + o.staff', 'v.c + o.club', 'v.sal', '1', 'v.e', 'v.fee'], ['s', 'c', 'sal', 'e', 'fee'],
    w.staff.filter((x) => x.clubId).map((x) => [x.id, x.clubId, x.weeklySalary, x.contractEnd, x.weeklySalary * 8])));

  s.push(bulk('sponsors', ['id', 'world_id', 'name', 'slot', 'min_reputation'],
    ['v.id + o.sponsor', 'o.w', 'v.name', 'v.slot', 'v.mr'], ['id', 'name', 'slot', 'mr'],
    w.sponsors.map((x) => [x.id, x.name, x.slot, x.minReputation])));

  s.push(bulk('sponsorship_contracts',
    ['sponsor_id', 'club_id', 'slot', 'per_round', 'bonus_per_win', 'start_season', 'end_season', 'break_fee'],
    ['v.s + o.sponsor', 'v.c + o.club', 'v.slot', 'v.pr', 'v.b', '1', 'v.e', 'v.f'], ['s', 'c', 'slot', 'pr', 'b', 'e', 'f'],
    w.sponsorships.map((x) => [x.sponsorId, x.clubId, x.slot, x.perRound, x.bonusPerWin, x.endSeason, x.breakFee])));

  s.push(bulk('matches', ['world_id', 'division_id', 'season', 'round', 'home_club', 'away_club'],
    ['o.w', 'v.tier + o.div', '1', 'v.r', 'v.h + o.club', 'v.a + o.club'], ['tier', 'r', 'h', 'a'],
    w.fixtures.map((f) => [f.tier, f.round, f.homeId, f.awayId])));

  s.push(bulk('standings', ['division_id', 'season', 'club_id'],
    ['v.tier + o.div', '1', 'v.c + o.club'], ['tier', 'c'], w.clubs.map((c) => [c.tier, c.id])));

  for (const t of ['cities', 'divisions', 'clubs', 'players', 'staff', 'sponsors'])
    s.push(`SELECT setval('${t}_id_seq', (SELECT max(id) FROM ${t}));`);
  s.push(`SELECT id AS world_id, join_code FROM worlds WHERE id = (SELECT w FROM _o);`);
  s.push('COMMIT;');
  return s.filter(Boolean).join('\n\n') + '\n';
}
