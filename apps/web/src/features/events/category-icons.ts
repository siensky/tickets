/** Ikon per kategori, för bildlösa kort (t.ex. lasttestarenan) och kategorichips. */
import { Drama, Music, PartyPopper, Trophy, type LucideIcon } from 'lucide-react';
import type { EventCategory } from '../../lib/categories.js';

export const CATEGORY_ICONS: Record<EventCategory, LucideIcon> = {
  music: Music,
  sports: Trophy,
  theatre: Drama,
  festival: PartyPopper,
};
