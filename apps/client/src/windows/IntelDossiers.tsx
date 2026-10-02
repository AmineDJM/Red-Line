import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NationDossier, NationId } from '@redline/shared';
import { Badge, EmptyState, Icon, ProgressBar, Select, formatMoney, formatPct } from '@redline/ui';
import { Ago, NationTag } from '../components/Common.js';
import { MiniMap } from '../components/MiniMap.js';
import { nationName } from '../lib/game.js';
import { threatTone } from '../lib/intelTabs.js';
import { useGameTime } from '../shell/helpers.js';
import { useGame } from '../store/game.js';
import { useWorld } from '../store/world.js';

const TONE_HEX = { red: '#ff4d5e', amber: '#ffb020', cyan: '#3cc8ff', green: '#3ddc84' } as const;

function capitalOf(id: NationId): [number, number] | null {
  const w = useWorld.getState();
  const cap = Object.values(w.provinces).find((p) => p.nationId === id && p.isCapital);
  return cap ? [cap.cityPoint[0], cap.cityPoint[1]] : null;
}

/** Indice de menace (0..100) : jauge colorée, tendance, alerte. */
export function ThreatBadge({ d }: { d: NationDossier }) {
  const { t } = useTranslation();
  const tone = threatTone(d.threat);
  return (
    <span className="threat" data-testid={`threat-${d.nationId}`}>
      {d.alert ? (
        <Badge tone="red" variant="solid" pulse>
          {t('intel.threat.alert')}
        </Badge>
      ) : null}
      <Badge tone={tone}>
        {d.threat}
        {d.trend > 0 ? ' ▲' : d.trend < 0 ? ' ▼' : ''}
      </Badge>
    </span>
  );
}

/** Carte des menaces : capitales des nations évaluées, cercle proportionnel à l'indice. */
export function ThreatMap({ dossiers }: { dossiers: NationDossier[] }) {
  const { t } = useTranslation();
  const markers = dossiers
    .map((d) => {
      const at = capitalOf(d.nationId);
      return at
        ? {
            at,
            radiusKm: 60 + d.threat * 6,
            color: TONE_HEX[threatTone(d.threat)],
            shape: 'ring' as const,
            label: `${nationName(d.nationId)} ${d.threat}`,
          }
        : null;
    })
    .filter((m): m is NonNullable<typeof m> => !!m);
  if (!markers.length) return null;
  const lon = markers.reduce((s, m) => s + m.at[0], 0) / markers.length;
  const lat = markers.reduce((s, m) => s + m.at[1], 0) / markers.length;
  const span = Math.max(
    800,
    ...markers.map((m) => Math.hypot((m.at[0] - lon) * 85, (m.at[1] - lat) * 111) + 400),
  );
  return (
    <MiniMap
      center={[lon, lat]}
      spanKm={span}
      markers={markers}
      height={170}
      label={t('intel.threat.title')}
      className="threatmap"
    />
  );
}

/** Liste compacte « théâtre → menace → indicateurs » (onglet militaire, dossiers). */
export function ThreatList({
  dossiers,
  onOpen,
}: {
  dossiers: NationDossier[];
  onOpen?: (id: NationId) => void;
}) {
  const { t } = useTranslation();
  if (!dossiers.length) return <EmptyState compact icon="target" title={t('intel.threat.empty')} />;
  return (
    <ul className="threats">
      {dossiers.map((d) => (
        <li key={d.nationId}>
          <button type="button" onClick={() => onOpen?.(d.nationId)} className="threats__row">
            <NationTag id={d.nationId} size={10} />
            <span className="threats__ind">
              {d.indicators.map((i) => t(`intel.indicators.${i}`)).join(' · ')}
            </span>
            <ThreatBadge d={d} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Range({ r }: { r: [number, number] }) {
  return <span className="range">{r[0] === r[1] ? r[0] : `${r[0]}–${r[1]}`}</span>;
}

/** Dossier pays : tout ce que l'on sait d'une nation. */
export function DossierView({ d }: { d: NationDossier }) {
  const { t } = useTranslation();
  const now = useGameTime(5000);
  const research = useWorld((s) => s.research);
  return (
    <div className="dossier" data-testid={`dossier-${d.nationId}`}>
      <header className="dossier__head">
        <NationTag id={d.nationId} strong />
        <ThreatBadge d={d} />
        <span className="muted">
          {t('intel.dossier.reliability')} <b>{d.reliability}</b>
        </span>
        <Ago from={d.updatedAt} now={now} />
      </header>
      {d.indicators.length ? (
        <div className="dossier__ind">
          {d.indicators.map((i) => (
            <Badge key={i} tone={i === 'war' || i === 'plans' ? 'red' : 'amber'} variant="outline">
              {t(`intel.indicators.${i}`)}
            </Badge>
          ))}
        </div>
      ) : null}
      <dl className="dossier__grid">
        <div>
          <dt>{t('intel.dossier.intentions')}</dt>
          <dd>
            {d.intentions ? (
              d.intentions.plansAgainst.length ? (
                <>
                  {t('intel.dossier.plansAgainst')}{' '}
                  {d.intentions.plansAgainst.map((x) => (
                    <NationTag key={x} id={x} size={9} />
                  ))}
                </>
              ) : (
                t('intel.dossier.noPlans')
              )
            ) : (
              '—'
            )}
            {d.intentions ? (
              <span className="muted">
                {' '}
                · {d.intentions.source.toUpperCase()} {d.intentions.reliability}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>{t('intel.dossier.economy')}</dt>
          <dd className="rl-money">
            {d.economy
              ? `${formatMoney(d.economy.money[0])} – ${formatMoney(d.economy.money[1])}`
              : '—'}
          </dd>
        </div>
        <div>
          <dt>{t('intel.dossier.research')}</dt>
          <dd>{d.tech?.research ? (research[d.tech.research]?.name ?? d.tech.research) : '—'}</dd>
        </div>
        <div>
          <dt>{t('intel.dossier.services')}</dt>
          <dd>{d.tech?.services !== undefined ? `N${d.tech.services}` : '—'}</dd>
        </div>
        <div>
          <dt>{t('intel.dossier.agents')}</dt>
          <dd>
            {d.agents}
            {d.access ? ` · ${t(`intel.accessLevels.${d.access}`)}` : ''}
          </dd>
        </div>
        <div>
          <dt>{t('intel.crypto.encryption')}</dt>
          <dd>{formatPct(d.encryption)}</dd>
        </div>
      </dl>
      <ProgressBar
        value={d.crypto}
        size="xs"
        tone="cyan"
        label={t('intel.crypto.title')}
        trailing={`${t('intel.crypto.title')} ${formatPct(d.crypto)}`}
      />
      <div className="dossier__forces">
        <span className="dept__label">{t('intel.dossier.forces')}</span>
        {d.forces ? (
          <table className="orbat">
            <tbody>
              <tr className="orbat__total">
                <th>Σ</th>
                <td>
                  <Range r={d.forces.total} />
                </td>
              </tr>
              {d.forces.cats.map((c) => (
                <tr key={c.category}>
                  <th>{t(`categories.${c.category}`)}</th>
                  <td>
                    <Range r={c.range} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="hint">—</p>
        )}
      </div>
    </div>
  );
}

/** Onglet « Dossiers » : carte des menaces, liste des nations, dossier choisi. */
export function Dossiers({ mobile }: { mobile?: boolean }) {
  const { t } = useTranslation();
  const dossiers = useGame((s) => s.view?.intel?.dossiers) ?? [];
  const [pick, setPick] = useState<NationId | null>(null);
  const cur = dossiers.find((d) => d.nationId === pick) ?? dossiers[0];
  if (!dossiers.length)
    return (
      <EmptyState icon="intel" title={t('intel.tabs.dossiers')} text={t('intel.dossier.empty')} />
    );
  return (
    <div className={mobile ? 'dossiers dossiers--mobile' : 'dossiers'}>
      <aside className="dossiers__side">
        <ThreatMap dossiers={dossiers} />
        {mobile ? (
          <Select
            value={cur?.nationId ?? ''}
            onChange={(v) => setPick(v)}
            options={dossiers.map((d) => ({
              value: d.nationId,
              label: `${nationName(d.nationId)} · ${d.threat}`,
            }))}
          />
        ) : (
          <ThreatList dossiers={dossiers} onOpen={setPick} />
        )}
      </aside>
      <section className="dossiers__main">{cur ? <DossierView d={cur} /> : null}</section>
    </div>
  );
}

/** Capteurs en service et décryptage par nation (onglet SIGINT). */
export function SigintPanel() {
  const { t } = useTranslation();
  const intel = useGame((s) => s.view?.intel);
  const s = intel?.sensors;
  const crypto = (intel?.dossiers ?? []).filter((d) => d.crypto > 0 || d.encryption > 0);
  return (
    <div className="sigint">
      <div className="sigint__sensors">
        <span className="dept__label">{t('intel.sensors.title')}</span>
        <div className="sigint__chips">
          <span>
            <Icon name="satellite" size={12} /> {t('intel.sensors.sigint')} <b>{s?.sigint ?? 0}</b>
          </span>
          <span>
            <Icon name="eye" size={12} /> {t('intel.sensors.imagery')} <b>{s?.imagery ?? 0}</b>
          </span>
          <span>
            <Icon name="radio" size={12} /> {t('intel.sensors.ew')} <b>{s?.ew ?? 0}</b>
          </span>
          {s?.bonus ? <Badge tone="green">+{formatPct(s.bonus)}</Badge> : null}
        </div>
      </div>
      <div className="sigint__crypto">
        <span className="dept__label">{t('intel.crypto.title')}</span>
        {crypto.length ? (
          crypto.map((d) => (
            <div key={d.nationId} className="sigint__row">
              <NationTag id={d.nationId} size={9} />
              <ProgressBar
                value={d.crypto}
                size="xs"
                tone={d.crypto >= 0.5 ? 'green' : d.crypto >= 0.25 ? 'amber' : 'red'}
                label={t('intel.crypto.title')}
                trailing={`${formatPct(d.crypto)} · ${t('intel.crypto.encryption')} ${formatPct(d.encryption)}`}
              />
            </div>
          ))
        ) : (
          <p className="hint">{t('intel.crypto.empty')}</p>
        )}
      </div>
    </div>
  );
}
