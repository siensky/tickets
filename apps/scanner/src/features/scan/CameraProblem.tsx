/** Kameran gick inte att starta (docs/plan.md 7.8): nekad behörighet får en instruktion. */
import type { JSX } from 'react';

export function CameraProblem({ kind }: { kind: 'denied' | 'unavailable' }): JSX.Element {
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-box border border-base-300 p-6">
      <h2>{kind === 'denied' ? 'Kameran är blockerad' : 'Kameran gick inte att starta'}</h2>
      {kind === 'denied' ? (
        <p>
          Tillåt kameran för den här sidan i webbläsarens inställningar (lås-ikonen vid
          adressfältet) och ladda sedan om sidan.
        </p>
      ) : (
        <p>Kontrollera att ingen annan app använder kameran och ladda om sidan.</p>
      )}
    </div>
  );
}
