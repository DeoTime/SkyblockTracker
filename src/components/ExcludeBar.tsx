import { usingMocks } from '../api/client';

interface Props {
  password: string;
  onPassword: (pw: string) => void;
  error: string | null;
}

/**
 * The admin-password field that unlocks the sold-items exclude checkboxes, with
 * inline error text. Hidden entirely in mock mode, where there is no gate and
 * the toggles work unconditionally — only the error (if any) is shown.
 */
export function ExcludeBar({ password, onPassword, error }: Props) {
  if (usingMocks) {
    return error ? (
      <span className="sub" style={{ color: 'var(--critical)' }}>
        {error}
      </span>
    ) : null;
  }

  return (
    <div className="filters" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <input
        className="input"
        type="password"
        autoComplete="off"
        placeholder="Admin password to edit"
        value={password}
        onChange={(e) => onPassword(e.target.value)}
        aria-label="Admin password to exclude flips"
        style={{ width: 200 }}
      />
      {error && (
        <span className="sub" style={{ color: 'var(--critical)' }}>
          {error}
        </span>
      )}
    </div>
  );
}
