// Armazenamento simples em arquivos JSON (pasta dados/), para testar localmente
// sem instalar banco de dados. Cada sala é um arquivo; usuários e sessões
// ficam em arquivos próprios. Escritas são atômicas (grava .tmp e renomeia).
//
// Para hospedar de verdade, troque este módulo por um que use o PostgreSQL
// (db/schema.sql). O resto do servidor só usa as funções exportadas aqui.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Room } from './engine.ts';

export interface User { id: string; username: string; salt: string; hash: string; createdAt: number }

const DATA_DIR = process.env.DADOS ?? join(process.cwd(), 'dados');
const ROOMS_DIR = join(DATA_DIR, 'salas');
const USERS_FILE = join(DATA_DIR, 'usuarios.json');
const SESSIONS_FILE = join(DATA_DIR, 'sessoes.json');

mkdirSync(ROOMS_DIR, { recursive: true });

function writeJson(file: string, data: unknown) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}
function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

// ------------------------------------------------------------- usuários
const users: User[] = readJson<User[]>(USERS_FILE, []);
const saveUsers = () => writeJson(USERS_FILE, users);
export const newId = () => randomBytes(9).toString('base64url');

export function findUser(username: string) {
  return users.find((u) => u.username.toLowerCase() === username.toLowerCase());
}
export const userById = (id: string) => users.find((u) => u.id === id);

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 32).toString('hex') };
}
export function checkPassword(password: string, salt: string, hash: string) {
  const h = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return h.length === expected.length && timingSafeEqual(h, expected);
}

export function createUser(username: string, password: string): User {
  const { salt, hash } = hashPassword(password);
  const u: User = { id: newId(), username, salt, hash, createdAt: Date.now() };
  users.push(u);
  saveUsers();
  return u;
}

// -------------------------------------------------------------- sessões
const sessions = new Map<string, { userId: string; expires: number }>(
  Object.entries(readJson<Record<string, { userId: string; expires: number }>>(SESSIONS_FILE, {})));
const saveSessions = () => writeJson(SESSIONS_FILE, Object.fromEntries(sessions));
const SESSION_MS = 30 * 24 * 3600 * 1000;

export function createSession(userId: string): string {
  const token = randomBytes(24).toString('base64url');
  sessions.set(token, { userId, expires: Date.now() + SESSION_MS });
  saveSessions();
  return token;
}
export function sessionUser(token: string | undefined): User | undefined {
  if (!token) return;
  const s = sessions.get(token);
  if (!s) return;
  if (s.expires < Date.now()) { sessions.delete(token); saveSessions(); return; }
  return userById(s.userId);
}
export function deleteSession(token: string | undefined) {
  if (token && sessions.delete(token)) saveSessions();
}

// ---------------------------------------------------------------- salas
const rooms = new Map<string, Room>();
for (const f of readdirSync(ROOMS_DIR)) {
  if (!f.endsWith('.json')) continue;
  const r = readJson<Room | null>(join(ROOMS_DIR, f), null);
  if (r) rooms.set(r.id, r);
}

export const allRooms = () => [...rooms.values()];
export const roomById = (id: string) => rooms.get(id);
export const roomByCode = (code: string) => allRooms().find((r) => r.code === code.toUpperCase());
export function saveRoom(room: Room) {
  rooms.set(room.id, room);
  writeJson(join(ROOMS_DIR, room.id + '.json'), room);
}
export const dataDir = DATA_DIR;
