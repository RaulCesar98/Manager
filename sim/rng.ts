// Gerador pseudoaleatório com semente (mulberry32).
// Usar semente fixa por partida torna a simulação reprodutível:
// dá para reexibir o "ao vivo" ou investigar um bug com o mesmo resultado.

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** número em [0, 1) */
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  /** aproximação de normal(0,1) */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.73;
  }
  /** escolhe um item com probabilidade proporcional ao peso */
  weighted<T>(items: T[], weight: (t: T) => number): T {
    const total = items.reduce((s, i) => s + Math.max(0, weight(i)), 0);
    let r = this.next() * total;
    for (const i of items) {
      r -= Math.max(0, weight(i));
      if (r <= 0) return i;
    }
    return items[items.length - 1];
  }
}
