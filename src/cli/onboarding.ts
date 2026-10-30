import { AppError } from '../domain/errors.js';
import type { ChoiceOption } from './choice-prompt.js';

import type { AuthMethod, AuthChoice, AuthSetup } from '../domain/auth.js';
export type SetupUI = { interactive: boolean; write(message: string): void; select<T extends string>(question: string, choices: readonly ChoiceOption<T>[], defaultValue: T): Promise<T> };
const label = (method: AuthMethod) => ({ chatgpt: 'ChatGPT account', 'api-key': 'OpenAI API key', unknown: 'Codex login (method not recognized)' })[method];

export async function onboard(auth: AuthSetup, ui: SetupUI, options: { auth?: AuthChoice; testConnection?: boolean } = {}): Promise<boolean> {
  let status = await auth.status();
  ui.write(status.saved ? `Saved sign-in: ${label(status.method)}.` : 'Welcome to DevAgents. Choose how to connect Codex.');
  let choice = options.auth;
  if (!choice && ui.interactive) {
    ui.write('ChatGPT uses your plan’s Codex allowance. API keys use separate API billing; key input is hidden.');
    const choices: ChoiceOption<AuthChoice>[] = [{ value: 'chatgpt', label: 'Sign in with ChatGPT' }, { value: 'api-key', label: 'Use an OpenAI API key' }];
    if (status.saved) choices.push({ value: 'saved', label: 'Continue with saved login (recommended)' });
    choice = await ui.select('How would you like to connect Codex?', choices, status.saved ? 'saved' : 'chatgpt');
  }
  choice ??= 'saved';
  if (choice === 'saved' && !status.saved) throw new AppError('missing_auth', 'No saved login. Run ./devagents start in your terminal to sign in.');
  if (choice !== 'saved') {
    if (!ui.interactive) throw new AppError('terminal_required', 'Sign-in needs an interactive terminal. Run ./devagents start in your terminal.');
    if (choice === 'chatgpt') {
      ui.write('Enable device code sign-in at https://chatgpt.com/#settings/Security (managed workspaces may require your administrator).');
      ui.write('Then open the official link printed below, sign in with ChatGPT, and enter the one-time code.');
    }
    await auth.login(choice);
    status = await auth.status();
    if (!status.saved || status.method !== choice) throw new AppError('login_unverified', 'The requested sign-in method was not confirmed. Run ./devagents start and try signing in again.');
    ui.write(`${label(status.method)} saved securely. Future starts can reuse it.`);
  }
  if (!status.saved) throw new AppError('missing_auth', 'No saved login.');
  ui.write(`Sign-in available: ${label(status.method)}. Model access has not been checked this start.`);
  let test = options.testConnection ?? false;
  if (!test && ui.interactive) {
    ui.write('The optional test sends a small request to the default Codex model. It uses your selected plan’s allowance or API credits. No project files are sent.');
    test = await ui.select('Test connection now?', [{ value: 'skip', label: 'Skip the test (default)' }, { value: 'test', label: 'Test connection — uses allowance or API credits' }], 'skip') === 'test';
  }
  if (!test) { ui.write('Connection test skipped. Model access will be checked when you run a task.'); return true; }
  ui.write('Testing the default Codex model…');
  const result = await auth.test(status.method);
  ui.write(result.message);
  return result.ok;
}
