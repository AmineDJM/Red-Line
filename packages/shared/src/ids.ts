/** Temps de jeu en millisecondes depuis le début de la partie. */
export type GameTime = number;
/** Instant réel (epoch ms). */
export type RealTime = number;

/** Coordonnées [longitude, latitude] en degrés, ordre GeoJSON. */
export type LngLat = [number, number];

export type NationId = string; // ex. "fra", "dza", "gaza", "pse"
export type ProvinceId = string; // ex. "fra-13"
export type UnitId = string; // ex. "u42"
export type SystemId = string; // ex. "us.f-16"
export type GameId = string;
export type UserId = string;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const EARTH_RADIUS_KM = 6371.0088;
