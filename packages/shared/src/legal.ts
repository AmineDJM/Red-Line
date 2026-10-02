import { z } from 'zod';

/**
 * Informations légales de l'éditeur, modifiables au back-office (Réglages › Légal) et insérées à l'envoi
 * dans les pages publiques et les documents légaux (jetons {{legal.<champ>}}).
 *
 *   GET  /admin/api/settings/legal → { settings, defaults, effective, publicUrl }
 *   PUT  /admin/api/settings/legal   LegalSettings → { settings, effective }   (superadmin)
 *   GET  /api/public/stats         → PublicStats (accueil du jeu)
 */
export const LegalSettingsSchema = z.object({
  publisherName: z.string().trim().min(1).max(120),
  publisherStatus: z.string().trim().min(1).max(160),
  tradeName: z.string().trim().max(120),
  siren: z.string().trim().max(40),
  siret: z.string().trim().max(40),
  vatNumber: z.string().trim().max(40),
  /** Mention d'immatriculation (« Non inscrit au RCS », RNE…). */
  registration: z.string().trim().max(200),
  address: z.string().trim().min(1).max(240),
  director: z.string().trim().min(1).max(120),
  /** Vide : LEGAL_CONTACT_EMAIL, sinon contact@<domaine de PUBLIC_URL>. */
  contactEmail: z.union([z.literal(''), z.string().trim().email().max(160)]),
  hostName: z.string().trim().min(1).max(120),
  hostAddress: z.string().trim().min(1).max(240),
  hostUrl: z.string().trim().max(200),
  dataRegion: z.string().trim().max(160),
  mediatorName: z.string().trim().max(200),
  mediatorUrl: z.string().trim().max(240),
  /** Mention de TVA des CGV (franchise en base ou régime réel). */
  vatMention: z.string().trim().max(200),
});
export type LegalSettings = z.infer<typeof LegalSettingsSchema>;
export type LegalSettingKey = keyof LegalSettings;

export const LEGAL_SETTING_KEYS = Object.keys(LegalSettingsSchema.shape) as LegalSettingKey[];

/** Valeurs pré-remplies (éditeur réel, à vérifier par Amine). */
export const LEGAL_DEFAULTS: LegalSettings = {
  publisherName: 'Amine Djouamai',
  publisherStatus: 'entrepreneur individuel (micro-entreprise)',
  tradeName: 'ALPHACONSULTING',
  siren: '921 737 607',
  siret: '921 737 607 00017',
  vatNumber: 'FR77921737607',
  registration: 'Non inscrit au registre du commerce et des sociétés (RCS)',
  address: "31 rue de l'Échiquier, 75010 Paris, France",
  director: 'Amine Djouamai',
  contactEmail: '',
  hostName: 'Render Services, Inc.',
  hostAddress: '525 Brannan Street, Suite 300, San Francisco, CA 94107, USA',
  hostUrl: 'https://render.com',
  dataRegion: 'Frankfurt (UE / EU)',
  mediatorName: '[médiateur de la consommation à désigner]',
  mediatorUrl: '',
  vatMention: 'TVA non applicable, art. 293 B du CGI',
};

export interface PublicStats {
  nations: number;
  provinces: number;
  systems: number;
  /** Parties en cours (toutes instances). */
  gamesRunning: number;
  /** Joueurs connectés à une partie sur cette instance. */
  playersOnline: number;
}
