import { create } from 'zustand';
import type { Aggressiveness, LngLat, MissionInput, Roe, UnitId } from '@redline/shared';
import type { StaffPick } from '../lib/ops.js';

/**
 * Centre de commandement : armée affichée, brouillon de l'assistant (composer → mission → général)
 * et désignation sur la carte. Le brouillon survit à la fermeture de la fenêtre : désigner une cible
 * ou des piles sur la carte ferme la fenêtre (une seule à la fois), puis la rouvre à l'étape en cours.
 */

export type WizardStep = 'compose' | 'mission' | 'general';

export interface MissionDraft {
  type: string | null;
  provinceId?: string;
  nationId?: string;
  at?: LngLat;
  radiusKm?: number;
  aggr: Aggressiveness;
  roe: Roe;
  retreatAt?: number;
  /** Conquérir : la province seule, la région autour d'elle, ou toute la nation. */
  scope?: 'province' | 'region' | 'nation';
}

export interface WizardDraft {
  /** Armée existante (changer de mission, renforcer) ; null : nouvelle armée. */
  armyId: string | null;
  /** Étapes proposées (nouvelle armée : les trois ; changer de mission : mission et général). */
  steps: WizardStep[];
  step: WizardStep;
  name: string;
  unitIds: UnitId[];
  mission: MissionDraft;
  /** Général choisi : recruté (`g…`) ou candidat du vivier (`cand…`). */
  generalId: string | null;
}

export type PickMode = 'target' | 'units' | 'nation' | null;

/** Étapes de l'assistant d'opération : cibles, objectif, généraux, confirmation. */
export type OpStep = 'targets' | 'goal' | 'staff' | 'confirm';

export interface OpDraft {
  /** Nouvelle opération, changement d'objectif, renforts (nouveaux généraux). */
  mode: 'new' | 'edit' | 'reinforce';
  opId: string | null;
  steps: OpStep[];
  step: OpStep;
  name: string;
  nations: string[];
  /** Région (Occuper) : provinces désignées sur la carte. */
  provinces: string[];
  goal: string | null;
  aggr: Aggressiveness;
  roe: Roe;
  /** Échéance (heures), null : sans échéance. */
  deadlineHours: number | null;
  staff: StaffPick[];
}

export type CommandTab = 'ops' | 'armies' | 'generals';

export interface CommandUiStore {
  /** Armée affichée dans la fenêtre. */
  selected: string | null;
  tab: CommandTab;
  draft: WizardDraft | null;
  picking: PickMode;
  /** Opération affichée, brouillon de l'assistant d'opération. */
  selectedOp: string | null;
  opDraft: OpDraft | null;
  select(id: string | null): void;
  setTab(tab: CommandTab): void;
  selectOp(id: string | null): void;
  startOp(d: Partial<OpDraft> & { steps: OpStep[] }): void;
  patchOp(d: Partial<OpDraft>): void;
  closeOp(): void;
  /** Pays (et province, pour Occuper) désignés sur la carte. */
  pickNation(t: { provinceId: string | null; nationId: string | null }): void;
  startWizard(d: Partial<WizardDraft> & { steps: WizardStep[] }): void;
  patch(d: Partial<WizardDraft>): void;
  patchMission(m: Partial<MissionDraft>): void;
  closeWizard(): void;
  setPicking(p: PickMode): void;
  /** Cible désignée sur la carte. */
  pickTarget(t: { provinceId: string | null; at: LngLat }): void;
}

export const EMPTY_MISSION: MissionDraft = { type: null, aggr: 'balanced', roe: 'standard' };

export const EMPTY_OP: Omit<OpDraft, 'steps' | 'step'> = {
  mode: 'new',
  opId: null,
  name: '',
  nations: [],
  provinces: [],
  goal: null,
  aggr: 'balanced',
  roe: 'standard',
  deadlineHours: null,
  staff: [],
};

export const useCommandUi = create<CommandUiStore>((set, get) => ({
  selected: null,
  tab: 'ops',
  draft: null,
  picking: null,
  selectedOp: null,
  opDraft: null,
  select(id) {
    set({ selected: id });
  },
  selectOp(id) {
    set({ selectedOp: id });
  },
  startOp(d) {
    set({ opDraft: { ...EMPTY_OP, step: d.steps[0]!, ...d }, draft: null, picking: null });
  },
  patchOp(d) {
    const cur = get().opDraft;
    if (cur) set({ opDraft: { ...cur, ...d } });
  },
  closeOp() {
    set({ opDraft: null, picking: null });
  },
  pickNation({ provinceId, nationId }) {
    const cur = get().opDraft;
    if (!cur) return set({ picking: null });
    const nations =
      nationId && !cur.nations.includes(nationId) ? [...cur.nations, nationId] : cur.nations;
    const provinces =
      cur.goal === 'occupy' && provinceId
        ? cur.provinces.includes(provinceId)
          ? cur.provinces.filter((p) => p !== provinceId)
          : [...cur.provinces, provinceId]
        : cur.provinces;
    set({ picking: null, opDraft: { ...cur, nations, provinces } });
  },
  setTab(tab) {
    set({ tab });
  },
  startWizard(d) {
    set({
      draft: {
        armyId: null,
        name: '',
        unitIds: [],
        mission: { ...EMPTY_MISSION },
        generalId: null,
        step: d.steps[0]!,
        ...d,
      },
      picking: null,
    });
  },
  patch(d) {
    const cur = get().draft;
    if (cur) set({ draft: { ...cur, ...d } });
  },
  patchMission(m) {
    const cur = get().draft;
    if (cur) set({ draft: { ...cur, mission: { ...cur.mission, ...m } } });
  },
  closeWizard() {
    set({ draft: null, picking: null });
  },
  setPicking(p) {
    set({ picking: p });
  },
  pickTarget({ provinceId, at }) {
    const cur = get().draft;
    if (!cur) return set({ picking: null });
    set({
      picking: null,
      draft: {
        ...cur,
        mission: {
          ...cur.mission,
          at,
          ...(provinceId ? { provinceId } : { provinceId: undefined }),
        },
      },
    });
  },
}));

/** Ordre de mission à partir du brouillon (cible normalisée selon la portée choisie). */
export function missionInput(
  m: MissionDraft,
  nationOf: (pid: string) => string | undefined,
): MissionInput | null {
  if (!m.type) return null;
  const out: MissionInput = { type: m.type, aggr: m.aggr, roe: m.roe };
  if (m.retreatAt !== undefined) out.retreatAt = m.retreatAt;
  if (m.scope === 'nation' && m.provinceId) {
    const n = nationOf(m.provinceId);
    if (n) out.nationId = n;
  } else {
    if (m.provinceId) out.provinceId = m.provinceId;
    if (m.nationId) out.nationId = m.nationId;
  }
  if (m.at) out.at = [m.at[0], m.at[1]];
  if (m.radiusKm !== undefined) out.radiusKm = m.radiusKm;
  if (m.scope === 'province') out.radiusKm = 0;
  return out;
}
