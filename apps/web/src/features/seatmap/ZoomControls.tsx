/** Knappar för zoom in/ut/återställ. Måste ligga inuti en `TransformWrapper`. */
import { Maximize2, Minus, Plus } from 'lucide-react';
import type { JSX } from 'react';
import { useControls } from 'react-zoom-pan-pinch';
import { Button } from '../../components/ui/Button.js';

export function ZoomControls(): JSX.Element {
  const { zoomIn, zoomOut, resetTransform } = useControls();
  return (
    <div className="absolute top-3 right-3 z-10 flex flex-col gap-2">
      <Button
        size="md"
        variant="secondary"
        className="min-w-11 bg-base-100"
        aria-label="Zooma in"
        onClick={() => void zoomIn()}
      >
        <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
      </Button>
      <Button
        size="md"
        variant="secondary"
        className="min-w-11 bg-base-100"
        aria-label="Zooma ut"
        onClick={() => void zoomOut()}
      >
        <Minus size={16} strokeWidth={1.75} aria-hidden="true" />
      </Button>
      <Button
        size="md"
        variant="secondary"
        className="min-w-11 bg-base-100"
        aria-label="Återställ zoom"
        onClick={() => void resetTransform()}
      >
        <Maximize2 size={16} strokeWidth={1.75} aria-hidden="true" />
      </Button>
    </div>
  );
}
