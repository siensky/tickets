/**
 * En ny version laddas in vid nästa sidbyte, aldrig vid första renderingen och aldrig medan Auth0:s
 * återkomst (`code` + `state`) ligger i adressfältet.
 */
import { act, render } from '@testing-library/react';
import { useEffect, type JSX } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { useReloadIntoNewVersion } from '../use-reload-into-new-version.js';

function Probe({
  isReady,
  reload,
  onNavigate,
}: {
  isReady: () => boolean;
  reload: () => void;
  onNavigate: (navigate: (to: string) => void) => void;
}): JSX.Element {
  useReloadIntoNewVersion(isReady, reload);
  const navigate = useNavigate();
  useEffect(() => onNavigate((to) => void navigate(to)), [navigate, onNavigate]);
  return <p>probe</p>;
}

function setup(
  initialPath: string,
  ready: boolean,
): {
  reload: ReturnType<typeof vi.fn>;
  go: (to: string) => void;
} {
  const reload = vi.fn();
  let navigateTo: (to: string) => void = () => undefined;
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Probe
        isReady={() => ready}
        reload={reload}
        onNavigate={(navigate) => {
          navigateTo = navigate;
        }}
      />
    </MemoryRouter>,
  );
  return { reload, go: (to) => act(() => navigateTo(to)) };
}

describe('useReloadIntoNewVersion', () => {
  it('laddar om vid nästa sidbyte när en ny version tagit över', () => {
    const { reload, go } = setup('/events/e1', true);
    expect(reload).not.toHaveBeenCalled();

    go('/events/e1/queue');

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('laddar inte om när ingen ny version finns', () => {
    const { reload, go } = setup('/events/e1', false);

    go('/events/e1/queue');

    expect(reload).not.toHaveBeenCalled();
  });

  it('laddar inte om medan Auth0:s återkomst ligger i adressfältet', () => {
    const { reload, go } = setup('/events/e1', true);

    go('/?code=abc&state=xyz');

    expect(reload).not.toHaveBeenCalled();
  });
});
