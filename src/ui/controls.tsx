import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { fx } from './feedback';

type Tone = 'lime' | 'cyan' | 'pink' | 'violet' | 'orange' | 'green' | 'red' | 'plain' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  /** El click ya suena solo; esto lo silencia donde molesta. */
  quiet?: boolean;
}

export function Button({
  tone = 'plain',
  size = 'md',
  block,
  quiet,
  className = '',
  onClick,
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    tone !== 'plain' && tone !== 'ghost' ? `btn-${tone}` : '',
    tone === 'ghost' ? 'btn-ghost' : '',
    size === 'lg' ? 'btn-lg' : '',
    size === 'sm' ? 'btn-sm' : '',
    block ? 'btn-block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={classes}
      onClick={(event) => {
        if (!quiet) fx.tap();
        onClick?.(event);
      }}
      {...rest}
    />
  );
}

interface SwitchProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}

export function Switch({ checked, onChange, label, hint }: SwitchProps) {
  return (
    <button
      type="button"
      className="switch"
      aria-pressed={checked}
      onClick={() => {
        fx.tap();
        onChange(!checked);
      }}
    >
      <span>
        <span className="label">{label}</span>
        {hint ? <span className="muted" style={{ display: 'block' }}>{hint}</span> : null}
      </span>
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
    </button>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  tint?: string;
  ariaLabel: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  tint,
  ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel} style={tint ? { ['--seg-active' as string]: tint } : undefined}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => {
            fx.tap();
            onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/** Hoja que sube desde abajo. Se cierra tocando afuera o con Escape. */
export function Sheet({ open, onClose, title, children }: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Bloqueamos el scroll de atras para que el gesto no arrastre la pagina.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (!panel.current?.contains(event.target as Node)) onClose();
      }}
    >
      <div className="sheet" ref={panel}>
        <div className="sheet-grip" />
        <div className="stack">
          <h2 style={{ fontSize: 22 }}>{title}</h2>
          {children}
        </div>
      </div>
    </div>
  );
}
