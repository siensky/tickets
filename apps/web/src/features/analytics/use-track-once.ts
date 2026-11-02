/**
 * Skickar en händelse en gång per unik uppsättning props, och väntar tills propsen finns
 * (`undefined` = ännu inte redo, t.ex. eventet laddas). Hindrar dubbla händelser när en
 * komponent renderas om.
 */
import type { ClientEvents } from '@tickets/analytics';
import { useEffect, useRef } from 'react';
import { track } from '../../lib/analytics.js';

export function useTrackOnce<Name extends keyof ClientEvents>(
  name: Name,
  props: ClientEvents[Name] | undefined,
): void {
  const sentKey = useRef<string | undefined>(undefined);
  const key = props === undefined ? undefined : JSON.stringify(props);
  useEffect(() => {
    if (props === undefined || sentKey.current === key) {
      return;
    }
    sentKey.current = key;
    track(name, props);
  });
}
