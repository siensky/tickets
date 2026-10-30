/** Banner när kontakten med kön tappats. Platsen behålls: token är sparad och pollingen fortsätter. */
import { Alert } from '../../components/ui/Alert.js';
import type { JSX } from 'react';

export function ConnectionBanner(): JSX.Element {
  return (
    <Alert tone="warning">
      <strong>Återansluter…</strong> Din plats i kön behålls. Stäng inte fliken.
    </Alert>
  );
}
