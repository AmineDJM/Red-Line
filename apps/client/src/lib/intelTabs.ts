import type { Department, IntelOpKind, IntelReport } from '@redline/shared';

/**
 * Organisation de la console de renseignement : sept onglets (SIGINT, HUMINT, militaire, intérieur,
 * détenus, dossiers, rapports), opérations proposées par onglet, nature de la cible de chaque opération.
 * Données pures (testées sans navigateur).
 */
export const INTEL_TABS = [
  'sigint',
  'humint',
  'military',
  'interior',
  'detainees',
  'dossiers',
  'reports',
] as const;
export type IntelTab = (typeof INTEL_TABS)[number];
export type OpsTab = Exclude<IntelTab, 'dossiers' | 'reports' | 'detainees'>;

/** Département qui conduit les opérations d'un onglet (budget et capacité affichés). */
export const TAB_DEPT: Record<OpsTab, Department> = {
  sigint: 'military',
  humint: 'exterior',
  military: 'military',
  interior: 'interior',
};

/** Opérations proposées par onglet (la première est l'action par défaut). */
export const TAB_OPS: Record<OpsTab, IntelOpKind[]> = {
  sigint: [
    'intercept_comms',
    'cryptanalysis',
    'geolocate_emitters',
    'listen_area',
    'intercept_army',
    'jam_area',
    'fake_radio_traffic',
    'cyber_radar',
    'cyber_production',
    'cyber_orders',
  ],
  humint: [
    'infiltrate_spy',
    'recruit_source',
    'cultivate_source',
    'vet_agents',
    'exfiltrate',
    'recon_economic',
    'steal_research',
    'sabotage_factory',
    'fund_rebels',
    'leak_plans',
    'disinformation',
    'plant_fake_report',
  ],
  military: ['recon_military', 'designate_targets', 'deploy_decoys'],
  interior: [
    'counterintel_sweep',
    'dismantle_network',
    'deception_plan',
    'harden_sites',
    'turn_agent',
  ],
};

/** Nature de la cible attendue par le moteur pour chaque opération. */
export type TargetKind = 'none' | 'nation' | 'province' | 'area' | 'ownArea' | 'unit' | 'agent';
export const TARGET_KIND: Record<IntelOpKind, TargetKind> = {
  infiltrate_spy: 'nation',
  recruit_source: 'nation',
  turn_agent: 'nation',
  exfiltrate: 'nation',
  steal_research: 'nation',
  sabotage_factory: 'province',
  fund_rebels: 'province',
  listen_area: 'area',
  intercept_army: 'unit',
  jam_area: 'area',
  cyber_radar: 'nation',
  cyber_production: 'nation',
  cyber_orders: 'nation',
  disinformation: 'nation',
  leak_plans: 'nation',
  plant_fake_report: 'nation',
  deploy_decoys: 'ownArea',
  fake_radio_traffic: 'area',
  counterintel_sweep: 'none',
  recon_economic: 'province',
  recon_military: 'province',
  cryptanalysis: 'nation',
  intercept_comms: 'nation',
  geolocate_emitters: 'nation',
  cultivate_source: 'agent',
  vet_agents: 'nation',
  designate_targets: 'province',
  dismantle_network: 'nation',
  deception_plan: 'nation',
  harden_sites: 'none',
};

/** Opérations de reconnaissance : la cible peut être une province ou toute la nation. */
export const WHOLE_NATION_OK: ReadonlySet<IntelOpKind> = new Set([
  'recon_economic',
  'recon_military',
]);

/** Opérations qui implantent un agent : choix de la couverture. */
export const COVER_OPS: ReadonlySet<IntelOpKind> = new Set(['infiltrate_spy', 'recruit_source']);

/** Onglet où un rapport est classé. */
export function tabOfReport(r: Pick<IntelReport, 'dept' | 'source' | 'kind'>): OpsTab {
  if (r.dept === 'interior') return 'interior';
  if (r.dept === 'exterior') return 'humint';
  return r.kind === 'daily' || r.kind === 'flash' || r.kind === 'order_of_battle'
    ? 'military'
    : 'sigint';
}

/** Couleur d'un indice de menace (0..100). */
export function threatTone(th: number): 'red' | 'amber' | 'cyan' | 'green' {
  return th >= 60 ? 'red' : th >= 35 ? 'amber' : th >= 15 ? 'cyan' : 'green';
}
