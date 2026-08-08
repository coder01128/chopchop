import { useState, type FormEvent } from 'react';
import { useAuth } from './AuthProvider';
import styles from './SignIn.module.css';

/**
 * Email and password only.
 *
 * There is no sign-up screen and no password-reset flow, by design: sellers
 * never self-register. Brad creates the login with scripts/create-seller.mjs
 * and hands it over. A ticket that asks for a signup flow is wrong.
 */
export function SignIn() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const { error: signInError } = await signIn(email.trim(), password);

    if (signInError) {
      // Supabase says "Invalid login credentials" for both a wrong password and
      // an unknown email, which is the right amount to tell the browser.
      setError(signInError);
      setBusy(false);
    }
    // On success the auth listener swaps this screen out; leave `busy` set so
    // the button cannot be pressed twice during the swap.
  }

  return (
    <main className={styles.screen}>
      <form className={styles.card} onSubmit={onSubmit}>
        <p className="cc-eyebrow">ChopChop</p>
        <h1 className={styles.heading}>Sign in</h1>
        <p className={styles.blurb}>Seller dashboard. Your login was set up for you.</p>

        <label className={styles.field}>
          <span>Email</span>
          <input
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className={styles.field}>
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </label>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <button className={styles.submit} type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
