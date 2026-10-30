/**
 * Sökfältet sätter `?q=` på startsidan. Navbaren monterar om det med `key={query}`, så att
 * fältet följer URL:en vid bakåt-klick i stället för att visa en gammal söktext.
 */
import { Search } from 'lucide-react';
import { useState, type FormEvent, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';

export function SearchBox({
  initialQuery,
  onSubmitted,
}: {
  initialQuery: string;
  onSubmitted?: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const [value, setValue] = useState(initialQuery);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = value.trim();
    void navigate(trimmed.length > 0 ? `/?q=${encodeURIComponent(trimmed)}` : '/');
    onSubmitted?.();
  }

  return (
    <form onSubmit={handleSubmit} role="search" aria-label="Sök evenemang">
      <label className="input input-bordered flex min-h-11 w-full items-center gap-2 rounded-field">
        <Search size={16} strokeWidth={1.75} className="text-muted" aria-hidden="true" />
        <input
          type="search"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Sök evenemang eller artist"
          aria-label="Sök evenemang"
          className="grow"
        />
      </label>
    </form>
  );
}
