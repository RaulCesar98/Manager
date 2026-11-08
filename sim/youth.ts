// Divisão de base: gera a "peneira" de novos jogadores (1x por temporada).
// Qualidade depende do nível das instalações da base e do treinador da base.

import type { Rng } from './rng.ts';
import { ATTRIBUTES, type Attribute, type Player, type Position } from './types.ts';

export const FIRST = ['João', 'Pedro', 'Lucas', 'Gabriel', 'Matheus', 'Rafael', 'Thiago', 'Vitor', 'Caio', 'Enzo',
  'Davi', 'Arthur', 'Bruno', 'Felipe', 'Igor', 'Kauã', 'Luan', 'Murilo', 'Nathan', 'Otávio'];
export const LAST = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Lima', 'Ferreira', 'Costa', 'Rocha', 'Almeida',
  'Gomes', 'Ribeiro', 'Martins', 'Carvalho', 'Barbosa', 'Pereira', 'Nunes', 'Moura', 'Teixeira'];

// Atributos que mais importam em cada posição recebem bônus na geração
const FAVORED: Record<Position, Attribute[]> = {
  GOL: ['goalkeeping'],
  ZAG: ['defending', 'heading', 'strength'],
  LAT: ['pace', 'defending', 'stamina'],
  VOL: ['defending', 'passing', 'stamina'],
  MEI: ['passing', 'vision', 'dribbling'],
  ATA: ['finishing', 'pace', 'dribbling'],
};

export function generateYouthIntake(
  baseLevel: number,     // 1..10
  youthCoach: number,    // 1..100
  rng: Rng,
  nextId: () => number,
): Player[] {
  const count = 3 + Math.floor(baseLevel / 3) + rng.int(0, 2);
  const out: Player[] = [];
  for (let i = 0; i < count; i++) {
    const position = rng.weighted<Position>(['GOL', 'ZAG', 'LAT', 'VOL', 'MEI', 'ATA'],
      (p) => (p === 'GOL' ? 0.6 : p === 'ATA' || p === 'MEI' ? 1.3 : 1));
    const quality = 22 + baseLevel * 2.2 + youthCoach * 0.08 + rng.gauss() * 6;
    const attrs = {} as Record<Attribute, number>;
    for (const a of ATTRIBUTES) {
      let v = quality + rng.gauss() * 7;
      if (FAVORED[position].includes(a)) v += 12;
      if (a === 'goalkeeping' && position !== 'GOL') v = 5 + rng.int(0, 10);
      attrs[a] = Math.round(Math.max(1, Math.min(100, v)));
    }
    // Potencial: a "joia" rara aparece mais em bases boas
    const jewel = rng.chance(0.02 + baseLevel * 0.008 + youthCoach * 0.0004);
    const potential = Math.round(Math.max(40, Math.min(99,
      50 + baseLevel * 2 + youthCoach * 0.08 + rng.gauss() * 7 + (jewel ? 12 : 0))));

    out.push({
      id: nextId(),
      name: `${FIRST[rng.int(0, FIRST.length - 1)]} ${LAST[rng.int(0, LAST.length - 1)]}`,
      age: rng.int(15, 17),
      position, attrs, potential,
      form: 50, fitness: 100, morale: 70, popularity: 0,
    });
  }
  return out;
}
