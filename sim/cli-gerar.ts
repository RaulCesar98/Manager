// Gera um mundo pela linha de comando.
//   node --experimental-strip-types sim/cli-gerar.ts --seed 42 --dificuldade NORMAL \
//        --divisoes 2 --clubes 20 [--patch meu.json] [--csv jogadores.csv] \
//        [--sql saida.sql] [--exportar patch.json] [--exportar-csv jogadores.csv]

import { readFileSync, writeFileSync } from 'node:fs';
import { parsePatchJson, parsePlayersCsv, exportPatch, playersToCsv } from './importexport.ts';
import { DEFAULT_SETTINGS, validateSettings, type Difficulty, type RoomSettings } from './settings.ts';
import { overall } from './strength.ts';
import { worldToSql } from './tosql.ts';
import { generateWorld, type CustomWorld } from './worldgen.ts';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const settings: RoomSettings = structuredClone(DEFAULT_SETTINGS);
settings.name = args.get('nome') ?? 'Sala de teste';
settings.difficulty = (args.get('dificuldade') ?? 'NORMAL') as Difficulty;
settings.structure.divisions = Number(args.get('divisoes') ?? 2);
settings.structure.clubsPerDivision = Number(args.get('clubes') ?? 20);
settings.maxHumans = Math.min(settings.maxHumans, settings.structure.clubsPerDivision);

const errs = validateSettings(settings);
if (errs.length) { console.error('Configuração inválida:\n- ' + errs.join('\n- ')); process.exit(1); }

let patch: CustomWorld = {};
if (args.get('patch')) {
  const r = parsePatchJson(readFileSync(args.get('patch')!, 'utf8'));
  if (r.errors.length) { console.error('Erros no patch:\n- ' + r.errors.join('\n- ')); process.exit(1); }
  patch = r.patch;
}
if (args.get('csv')) {
  const r = parsePlayersCsv(readFileSync(args.get('csv')!, 'utf8'));
  if (r.errors.length) { console.error('Erros no CSV:\n- ' + r.errors.join('\n- ')); process.exit(1); }
  patch.players = [...(patch.players ?? []), ...r.players];
}

const world = generateWorld(settings, Number(args.get('seed') ?? Date.now() % 2147483647), patch);
for (const w of world.warnings) console.warn('Aviso:', w);

const fmt = (n: number) => n.toLocaleString('pt-BR');
console.log(`Mundo "${settings.name}" (semente ${world.seed}, dificuldade ${settings.difficulty})`);
console.log(`${world.cities.length} cidades | ${world.clubs.length} clubes | ${world.players.length} jogadores | ${world.staff.length} membros de staff | ${world.sponsors.length} patrocinadores | ${world.fixtures.length} jogos`);
for (const d of world.divisions) {
  console.log(`\n${d.name}:`);
  const clubs = world.clubs.filter((c) => c.tier === d.tier).sort((a, b) => b.reputation - a.reputation);
  for (const c of clubs) {
    const city = world.cities.find((x) => x.id === c.cityId)!;
    const squad = world.players.filter((p) => p.clubId === c.id && !p.isYouth);
    const avg = squad.map(overall).sort((a, b) => b - a).slice(0, 11).reduce((s, x) => s + x, 0) / 11;
    const rival = world.clubs.find((x) => x.id === c.rivalId);
    console.log(`  ${c.shortName.padEnd(4)} ${c.name.padEnd(34)} ${(city.name + '/' + city.state).padEnd(22)} rep ${String(c.reputation).padStart(2)} | time ${avg.toFixed(0)} | torcida ${fmt(c.fanBase).padStart(10)}${rival ? ` | rival ${rival.shortName}` : ''}`);
  }
}

if (args.get('sql')) { writeFileSync(args.get('sql')!, worldToSql(world)); console.log(`\nSQL salvo em ${args.get('sql')}`); }
if (args.get('exportar')) { writeFileSync(args.get('exportar')!, exportPatch(world)); console.log(`Patch salvo em ${args.get('exportar')}`); }
if (args.get('exportar-csv')) { writeFileSync(args.get('exportar-csv')!, playersToCsv(world)); console.log(`CSV salvo em ${args.get('exportar-csv')}`); }
