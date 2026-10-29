export type AuthMethod = 'chatgpt' | 'api-key' | 'unknown';
export type AuthChoice = 'chatgpt' | 'api-key' | 'saved';
export type AuthStatus = { saved: false } | { saved: true; method: AuthMethod };
export type ConnectionResult = { ok: boolean; message: string };
export interface AuthSetup {
  status(): Promise<AuthStatus>;
  login(method: Exclude<AuthMethod, 'unknown'>): Promise<void>;
  test(method: AuthMethod): Promise<ConnectionResult>;
}
