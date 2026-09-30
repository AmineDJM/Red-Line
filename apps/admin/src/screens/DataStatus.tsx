/** Statut des données : révision en vigueur, volumes chargés, avertissements du chargement. */
import { useSession } from '../context';
import { Button, ErrorBox, Icon, Note, PageHead, Spinner, Stat, Win } from '../components/term';
import { T } from '../i18n';
import { useLoad } from '../lib/hooks';
import { useSystems } from '../lib/refs';
import { href } from '../lib/router';

export function DataStatusScreen() {
  const { api } = useSession();
  const { data, error, loading, reload } = useLoad(() => api.dataStatus(), [api], T.roles.balance);
  const systems = useSystems().data;
  return (
    <>
      <PageHead
        title={T.dataStatus.title}
        sub={T.dataStatus.sub}
        actions={
          <Button onClick={() => void reload()}>
            <Icon name="refresh" size={14} /> {T.app.refresh}
          </Button>
        }
      />
      {error && <ErrorBox message={error} onRetry={() => void reload()} />}
      {loading && !data && <Spinner />}
      {data && (
        <>
          <div className="stats">
            <Stat k={T.dataStatus.rev} v={`#${data.rev}`} tone="var(--t-cyan)" />
            <Stat
              k={T.nav.catalog}
              v={systems?.length ?? '…'}
              d={<a href={href({ name: 'catalog' })}>{T.app.open}</a>}
            />
            <Stat
              k={T.dataStatus.research}
              v={data.research}
              d={<a href={href({ name: 'research' })}>{T.app.open}</a>}
            />
            <Stat
              k={T.dataStatus.orbats}
              v={Object.values(data.orbats).reduce((a, b) => a + b, 0)}
              d={
                Object.entries(data.orbats)
                  .map(([s, n]) => `${s} : ${n}`)
                  .join(' · ') || '—'
              }
            />
            <Stat k={T.dataStatus.scenarios} v={data.scenarios} />
            <Stat
              k={T.dataStatus.photos}
              v={data.photos}
              tone={data.photos ? undefined : 'var(--t-amber)'}
            />
          </div>
          <Win title={T.dataStatus.warnings} cmd="Get-DataLoadWarning" glyph="!">
            {data.warnings.length === 0 ? (
              <Note tone="ok">✓ {T.dataStatus.noWarnings}</Note>
            ) : (
              <ul className="issues warn">
                {data.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </Win>
          <Win title={T.dataStatus.catalogErrors} cmd="Test-Catalog -Path data/catalog" glyph="✕">
            {data.catalogErrors.length === 0 ? (
              <Note tone="ok">✓ {T.dataStatus.noErrors}</Note>
            ) : (
              <ul className="issues">
                {data.catalogErrors.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </Win>
        </>
      )}
    </>
  );
}
