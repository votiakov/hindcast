import { Cpu, Globe2, KeyRound, Sparkles, Cog, Database, DatabaseBackup, Globe, HardDrive, Inbox, Network, Server, ShieldCheck, SquareFunction, Users, Zap, type LucideIcon } from 'lucide-react';
import type { Kind } from '../sim/catalog';

export const KIND_ICONS: Record<Kind, LucideIcon> = {
  client: Users,
  cdn: Globe,
  lb: Network,
  gateway: ShieldCheck,
  server: Server,
  worker: Cog,
  function: SquareFunction,
  cache: Zap,
  db: Database,
  replica: DatabaseBackup,
  storage: HardDrive,
  queue: Inbox,
  llm: Cpu,
  llmapi: Sparkles,
  external: Globe2,
  kv: KeyRound,
};
