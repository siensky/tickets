/** Pilar på var sin sida, mitt i höjd, och prickar nere till höger. */
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { JSX } from 'react';
import { Container } from '../../components/ui/Container.js';

const ARROW_CLASS =
  'btn btn-circle absolute top-1/2 z-10 min-h-11 min-w-11 -translate-y-1/2 border-0 bg-base-100/90 text-base-content';

function Dots({
  count,
  selected,
  onGoTo,
}: {
  count: number;
  selected: number;
  onGoTo: (index: number) => void;
}): JSX.Element {
  return (
    <div className="ml-auto flex gap-1">
      {Array.from({ length: count }, (_, index) => (
        <button
          key={index}
          type="button"
          aria-label={`Visa evenemang ${index + 1}`}
          aria-current={index === selected}
          onClick={() => onGoTo(index)}
          className="flex h-6 w-6 items-center justify-center"
        >
          <span
            className={`h-2.5 rounded-full transition-all ${
              index === selected ? 'w-6 bg-base-100' : 'w-2.5 bg-base-100/60'
            }`}
          />
        </button>
      ))}
    </div>
  );
}

export function CarouselControls(props: {
  count: number;
  selected: number;
  onPrev: () => void;
  onNext: () => void;
  onGoTo: (index: number) => void;
}): JSX.Element {
  return (
    <>
      <button
        type="button"
        className={`${ARROW_CLASS} left-3 sm:left-6`}
        aria-label="Föregående"
        onClick={props.onPrev}
      >
        <ChevronLeft size={20} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`${ARROW_CLASS} right-3 sm:right-6`}
        aria-label="Nästa"
        onClick={props.onNext}
      >
        <ChevronRight size={20} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <div className="absolute inset-x-0 bottom-4 z-10">
        <Container className="flex">
          <Dots count={props.count} selected={props.selected} onGoTo={props.onGoTo} />
        </Container>
      </div>
    </>
  );
}
