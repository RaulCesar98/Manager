// Importação/exportação de "patches" da comunidade.
// Formatos com chaves em português para facilitar a edição à mão.
//
// JSON:
// {
//   "formato": "manager-patch", "versao": 1,
//   "clubes":    [{ "nome", "sigla", "cidade", "estado"?, "populacao"?, "divisao",
//                   "reputacao"?, "torcida"?, "estadio"?, "capacidade"? }],
//   "jogadores": [{ "nome", "clube" (sigla ou null), "posicao", "idade", "potencial"?,
//                   "atributos": { "velocidade", "resistencia", "forca", "passe", "drible",
//                                  "finalizacao", "defesa", "cabeceio", "goleiro", "visao" } }]
// }
//
// CSV de jogadores (separador ; ou ,), primeira linha = cabeçalho:
// nome;clube;posicao;idade;potencial;velocidade;resistencia;forca;passe;drible;finalizacao;defesa;cabeceio;goleiro;visao

import { overall } from './strength.ts';
import type { Attribute, Position } from './types.ts';
import type { CustomClub, CustomPlayer, CustomWorld, WorldData } from './worldgen.ts';

export const ATTR_PT: Record<string, Attribute> = {
  velocidade: 'pace', resistencia: 'stamina', forca: 'strength', passe: 'passing', drible: 'dribbling',
  finalizacao: 'finishing', defesa: 'defending', cabeceio: 'heading', goleiro: 'goalkeeping', visao: 'vision',
};
const PT_OF: Record<Attribute, string> = Object.fromEntries(
  Object.entries(ATTR_PT).map(([pt, en]) => [en, pt]),
) as Record<Attribute, string>;
const POSITIONS: Position[] = ['GOL', 'ZAG', 'LAT', 'VOL', 'MEI', 'ATA'];

const MAX_CLUBS = 200;
const MAX_PLAYERS = 8000;

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const isInt = (v: unknown, lo: number, hi: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const cleanText = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max) : '';

export interface ParseResult { patch: CustomWorld; errors: string[] }

// ================================================================= JSON
export function parsePatchJson(text: string): ParseResult {
  const errors: string[] = [];
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) {
    return { patch: {}, errors: [`JSON inválido: ${(e as Error).message}`] };
  }
  if (typeof data !== 'object' || data === null) return { patch: {}, errors: ['O arquivo precisa ser um objeto JSON.'] };
  const d = data as Record<string, unknown>;
  if (d.formato !== 'manager-patch') errors.push('Campo "formato" deve ser "manager-patch".');

  const clubs: CustomClub[] = [];
  const rawClubs = Array.isArray(d.clubes) ? d.clubes : [];
  if (rawClubs.length > MAX_CLUBS) errors.push(`Máximo de ${MAX_CLUBS} clubes.`);
  rawClubs.slice(0, MAX_CLUBS).forEach((c: any, i: number) => {
    const where = `clubes[${i}]`;
    const name = cleanText(c?.nome, 50), short = cleanText(c?.sigla, 4).toUpperCase(), city = cleanText(c?.cidade, 40);
    if (!name) return errors.push(`${where}: "nome" obrigatório.`);
    if (!/^[A-Z0-9]{2,4}$/.test(short)) return errors.push(`${where} (${name}): "sigla" deve ter 2 a 4 letras/números.`);
    if (!city) return errors.push(`${where} (${name}): "cidade" obrigatória.`);
    if (!isInt(c.divisao, 1, 4)) return errors.push(`${where} (${name}): "divisao" deve ser 1 a 4.`);
    if (c.reputacao !== undefined && !isInt(c.reputacao, 1, 100)) return errors.push(`${where} (${name}): "reputacao" 1 a 100.`);
    if (c.torcida !== undefined && !isInt(c.torcida, 500, 60_000_000)) return errors.push(`${where} (${name}): "torcida" inválida.`);
    if (c.capacidade !== undefined && !isInt(c.capacidade, 1000, 200_000)) return errors.push(`${where} (${name}): "capacidade" 1.000 a 200.000.`);
    if (c.populacao !== undefined && !isInt(c.populacao, 1000, 30_000_000)) return errors.push(`${where} (${name}): "populacao" inválida.`);
    clubs.push({
      name, shortName: short, city, state: cleanText(c.estado, 2).toUpperCase() || undefined,
      population: c.populacao, division: c.divisao, reputation: c.reputacao, fanBase: c.torcida,
      stadiumName: cleanText(c.estadio, 60) || undefined, stadiumCapacity: c.capacidade,
    });
  });
  const dupShort = findDuplicates(clubs.map((c) => c.shortName));
  if (dupShort.length) errors.push(`Siglas repetidas: ${dupShort.join(', ')}.`);

  const players: CustomPlayer[] = [];
  const rawPlayers = Array.isArray(d.jogadores) ? d.jogadores : [];
  if (rawPlayers.length > MAX_PLAYERS) errors.push(`Máximo de ${MAX_PLAYERS} jogadores.`);
  rawPlayers.slice(0, MAX_PLAYERS).forEach((p: any, i: number) => {
    const err = validatePlayer({
      name: p?.nome, club: p?.clube ?? null, position: p?.posicao, age: p?.idade,
      potential: p?.potencial, attrs: p?.atributos ?? {},
    }, `jogadores[${i}]`, players);
    if (err) errors.push(err);
  });

  return { patch: { clubs, players }, errors };
}

// ================================================================== CSV
export function parsePlayersCsv(text: string): { players: CustomPlayer[]; errors: string[] } {
  const errors: string[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { players: [], errors: ['CSV vazio ou só com cabeçalho.'] };
  const sep = (lines[0].match(/;/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const header = lines[0].split(sep).map(strip);
  const col = (n: string) => header.indexOf(n);
  for (const req of ['nome', 'clube', 'posicao', 'idade', ...Object.keys(ATTR_PT)])
    if (col(req) < 0) errors.push(`Coluna obrigatória ausente: ${req}.`);
  if (errors.length) return { players: [], errors };

  const players: CustomPlayer[] = [];
  lines.slice(1, MAX_PLAYERS + 1).forEach((line, i) => {
    const cells = line.split(sep).map((c) => c.trim());
    const num = (n: string) => (cells[col(n)] === '' || cells[col(n)] === undefined ? undefined : Number(cells[col(n)]));
    const attrs: Record<string, number | undefined> = {};
    for (const pt of Object.keys(ATTR_PT)) attrs[pt] = num(pt);
    const err = validatePlayer({
      name: cells[col('nome')], club: cells[col('clube')] || null, position: cells[col('posicao')]?.toUpperCase(),
      age: num('idade'), potential: col('potencial') >= 0 ? num('potencial') : undefined, attrs,
    }, `linha ${i + 2}`, players);
    if (err) errors.push(err);
  });
  return { players, errors };
}

function validatePlayer(raw: {
  name: unknown; club: unknown; position: unknown; age: unknown; potential: unknown; attrs: Record<string, unknown>;
}, where: string, out: CustomPlayer[]): string | null {
  const name = cleanText(raw.name, 40);
  if (!name) return `${where}: "nome" obrigatório.`;
  if (!POSITIONS.includes(raw.position as Position)) return `${where} (${name}): posição deve ser ${POSITIONS.join('/')}.`;
  if (!isInt(raw.age, 15, 45)) return `${where} (${name}): idade deve ser 15 a 45.`;
  if (raw.potential !== undefined && !isInt(raw.potential, 1, 99)) return `${where} (${name}): potencial 1 a 99.`;
  const attrs = {} as Record<Attribute, number>;
  for (const [pt, en] of Object.entries(ATTR_PT)) {
    const v = raw.attrs[pt];
    if (!isInt(v, 1, 99)) return `${where} (${name}): atributo "${pt}" deve ser inteiro de 1 a 99.`;
    attrs[en] = v as number;
  }
  const club = raw.club === null ? null : cleanText(raw.club, 4).toUpperCase() || null;
  out.push({ name, club, position: raw.position as Position, age: raw.age as number,
    potential: raw.potential as number | undefined, attrs });
  return null;
}

function findDuplicates(xs: string[]): string[] {
  const seen = new Set<string>(), dup = new Set<string>();
  for (const x of xs) (seen.has(x) ? dup : seen).add(x);
  return [...dup];
}

// ============================================================ exportar
/** Exporta o mundo como patch editável (sem jogadores da base). */
export function exportPatch(world: WorldData): string {
  const cityOf = new Map(world.cities.map((c) => [c.id, c]));
  const shortOf = new Map(world.clubs.map((c) => [c.id, c.shortName]));
  return JSON.stringify({
    formato: 'manager-patch', versao: 1,
    clubes: world.clubs.map((c) => {
      const city = cityOf.get(c.cityId)!;
      return {
        nome: c.name, sigla: c.shortName, cidade: city.name, estado: city.state, populacao: city.population,
        divisao: c.tier, reputacao: c.reputation, torcida: c.fanBase, estadio: c.stadiumName,
        capacidade: c.sectors.reduce((s, x) => s + x.capacity, 0),
      };
    }),
    jogadores: world.players.filter((p) => !p.isYouth).map((p) => ({
      nome: p.name, clube: p.clubId ? shortOf.get(p.clubId) : null, posicao: p.position, idade: p.age,
      potencial: p.potential,
      atributos: Object.fromEntries(Object.entries(p.attrs).map(([en, v]) => [PT_OF[en as Attribute], v])),
    })),
  }, null, 2);
}

export function playersToCsv(world: WorldData): string {
  const shortOf = new Map(world.clubs.map((c) => [c.id, c.shortName]));
  const attrs = Object.keys(ATTR_PT);
  const head = ['nome', 'clube', 'posicao', 'idade', 'potencial', ...attrs, 'overall'].join(';');
  const rows = world.players.filter((p) => !p.isYouth).map((p) =>
    [p.name, p.clubId ? shortOf.get(p.clubId) : '', p.position, p.age, p.potential,
      ...attrs.map((pt) => p.attrs[ATTR_PT[pt]]), overall(p)].join(';'));
  return [head, ...rows].join('\n');
}
